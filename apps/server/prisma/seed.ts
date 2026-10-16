import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client/client.js";
import { expenseCategories } from "@homedata/contracts";

const url =
  process.env.DATABASE_URL ??
  "postgresql://homedata:localdev@127.0.0.1:55432/homedata";
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

try {
  for (const [index, category] of expenseCategories.entries()) {
    await prisma.category.upsert({
      where: { code: category.code },
      create: { id: randomUUID(), ...category, sortOrder: index + 1 },
      update: { name: category.name, sortOrder: index + 1, isActive: true },
    });
  }
} finally {
  await prisma.$disconnect();
}
