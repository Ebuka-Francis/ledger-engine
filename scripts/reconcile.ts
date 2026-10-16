import { reconcile } from "../lib/reports";
import { prisma } from "../lib/prisma";

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("usage: npx tsx scripts/reconcile.ts <tenant_id>");
  process.exit(1);
}
const r = await reconcile(tenantId);
for (const c of r.checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.ok ? "" : `  (${c.count})`}`);
  for (const s of c.samples) console.log("        ", JSON.stringify(s));
}
await prisma.$disconnect();
// A non-zero exit code lets a scheduler (cron, CI, a hosting platform) raise an alert.
process.exit(r.ok ? 0 : 1);