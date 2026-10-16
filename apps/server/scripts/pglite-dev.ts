import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const dataDir = resolve(process.cwd(), "../../data/local-postgres");
await mkdir(dataDir, { recursive: true });
const database = new PGlite(dataDir);
await database.waitReady;
const port = Number(process.env.PGLITE_PORT ?? 55432);
const server = new PGLiteSocketServer({
  db: database,
  host: "127.0.0.1",
  port,
});
await server.start();
console.log(
  `Local PostgreSQL-compatible development database listening on 127.0.0.1:${port}`,
);

const close = async () => {
  await server.stop();
  await database.close();
  process.exit(0);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
