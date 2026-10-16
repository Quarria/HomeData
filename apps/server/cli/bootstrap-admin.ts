import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../prisma/generated/client/client.js";
import { hashPassword } from "../src/shared/auth/password.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://homedata:localdev@127.0.0.1:55432/homedata";
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl, max: 1 }),
});

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error("此命令必须在交互式终端运行，避免密码显示或从参数泄露。");
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("已取消管理员初始化。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error("此命令必须在交互式终端运行。请勿通过命令参数传入密码。");
  }
  const first = await readSecret("设置 admin 初始密码（12—128 位，不回显）：");
  if (first.length < 12 || first.length > 128) {
    throw new Error("密码长度必须为 12—128 个字符。");
  }
  const second = await readSecret("再次输入密码确认：");
  if (first !== second) throw new Error("两次密码不一致，未创建账号。");

  const passwordHash = await hashPassword(first);
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1::int AS locked WHERE pg_advisory_xact_lock(620261015) IS NULL`;
    const existing = await tx.account.count({
      where: { systemRole: "SYSTEM_ADMIN", status: "ACTIVE" },
    });
    if (existing > 0) return false;
    const sameUsername = await tx.account.findUnique({
      where: { usernameNormalized: "admin" },
    });
    if (sameUsername)
      throw new Error("用户名 admin 已占用，请联系系统管理员处理。");
    const account = await tx.account.create({
      data: {
        username: "admin",
        usernameNormalized: "admin",
        nickname: "系统管理员",
        passwordHash,
        systemRole: "SYSTEM_ADMIN",
        mustChangePassword: true,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: account.id,
        action: "INITIAL_SYSTEM_ADMIN_CREATED",
        subjectType: "ACCOUNT",
        subjectId: account.id,
      },
    });
    return true;
  });
  console.log(
    created
      ? "初始系统管理员 admin 已创建。首次登录后必须立即修改密码。"
      : "系统管理员已初始化，本次未修改任何账号。",
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
