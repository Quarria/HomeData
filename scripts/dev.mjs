import { spawn } from "node:child_process";
import net from "node:net";

const root = process.cwd();
const children = [];
const isWindows = process.platform === "win32";
const pnpm = isWindows ? "pnpm.cmd" : "pnpm";
const start = (name, args) => {
  const child = spawn(pnpm, args, {
    cwd: root,
    stdio: "inherit",
    shell: isWindows,
    env: process.env,
  });
  children.push({ name, child });
  child.once("exit", (code) => {
    if (code && code !== 0) void shutdown(code);
  });
  return child;
};
const shutdown = async (code = 0) => {
  for (const { child } of children) child.kill("SIGTERM");
  process.exit(code);
};
const waitForPort = (host, port) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const retry = () => {
      const socket = net.connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > 30_000)
          reject(
            new Error(`Timed out waiting for local database on port ${port}`),
          );
        else setTimeout(retry, 250);
      });
    };
    retry();
  });
const run = (name, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(pnpm, args, {
      cwd: root,
      stdio: "inherit",
      shell: isWindows,
      env: process.env,
    });
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}`)),
    );
  });

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
const useExternalDatabase = process.env.DEV_DATABASE === "external";
process.env.RUN_REMINDER_LOOP = useExternalDatabase ? "false" : "true";
if (useExternalDatabase && !process.env.DATABASE_URL) {
  throw new Error("DEV_DATABASE=external requires DATABASE_URL.");
}
process.env.DATABASE_URL ??=
  "postgresql://homedata:localdev@127.0.0.1:55432/homedata";
process.env.PGLITE_PORT ??= "55432";
process.env.SESSION_SECRET ??= "local-development-only-session-secret";
process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "local-development-only-encryption-key";
if (useExternalDatabase) {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  await waitForPort(databaseUrl.hostname, Number(databaseUrl.port || 5432));
} else {
  start("database", ["--filter", "@homedata/server", "dev:db"]);
  await waitForPort("127.0.0.1", 55432);
}
await run("database migration", [
  "--filter",
  "@homedata/server",
  "db:migrate:deploy",
]);
await run("category seed", ["--filter", "@homedata/server", "db:seed"]);
start("server", ["--filter", "@homedata/server", "dev"]);
if (useExternalDatabase) {
  start("worker", ["--filter", "@homedata/server", "worker"]);
}
start("web", ["--filter", "@homedata/web", "dev"]);
await new Promise(() => {});
