import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated/client/client.js";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const url = "postgresql://homedata:localdev@127.0.0.1:55433/homedata";
let database: PGlite | undefined;
let socketServer: PGLiteSocketServer | undefined;
let prisma: PrismaClient;

describe("M0 database integration", () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.waitReady;
    socketServer = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: 55433,
    });
    await socketServer.start();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const connected = await prisma.$queryRaw<
      Array<{ result: number }>
    >`SELECT 1 AS result`;
    if (Number(connected[0]?.result) !== 1)
      throw new Error("PGlite test database returned an unexpected result.");
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await socketServer?.stop();
    await database?.close();
  });

  it("connects through the standard PostgreSQL driver protocol", async () => {
    const result = await prisma.$queryRaw<
      Array<{ result: number }>
    >`SELECT 1 AS result`;
    expect(Number(result[0]?.result)).toBe(1);
  });
});
