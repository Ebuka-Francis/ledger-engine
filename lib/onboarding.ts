import { randomUUID } from "node:crypto";
import { asTenant } from "./tenant";
import { createApiKey } from "./auth";

// Creates a tenant with the two accounts the webhook worker posts to
// (1000 Cash, 4000 Revenue) and a first API key. Needs no admin database
// access: the tenant row is inserted under its own tenant context.
export async function createTenant(name: string, currency = "NGN") {
  const tenantId = randomUUID();
  await asTenant(tenantId, async (tx) => {
    await tx.tenants.create({ data: { id: tenantId, name } });
    await tx.accounts.createMany({
      data: [
        { tenant_id: tenantId, code: "1000", name: "Cash", type: "asset", currency },
        { tenant_id: tenantId, code: "4000", name: "Revenue", type: "revenue", currency },
      ],
    });
  });
  const apiKey = await createApiKey(tenantId, "default");
  return { tenantId, apiKey: apiKey.key, apiKeyId: apiKey.id };
}