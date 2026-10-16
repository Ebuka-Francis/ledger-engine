import { createTenant } from "../lib/onboarding";
import { prisma } from "../lib/prisma";

const name = process.argv[2];
if (!name) {
  console.error('usage: npx tsx scripts/create-tenant.ts "Company name"');
  process.exit(1);
}
const t = await createTenant(name);
console.log("tenant id :", t.tenantId);
console.log("api key   :", t.apiKey);
console.log("\nSave the API key now. It is not stored anywhere and cannot be shown again.");
await prisma.$disconnect();