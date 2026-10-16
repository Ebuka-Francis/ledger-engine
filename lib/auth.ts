import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { asTenant } from "./tenant";

const KEY_RE = /^lk_live_[A-Za-z0-9_-]{20,64}$/;

// API keys are long random strings, so a fast hash (sha256) is enough here.
// (Passwords need a slow hash like bcrypt because people pick guessable ones;
// 192 random bits can't be guessed, so there is nothing for slowness to protect.)
export const hashKey = (key: string) => createHash("sha256").update(key, "utf8").digest("hex");

export function generateKey(): string {
  return "lk_live_" + randomBytes(24).toString("base64url");
}

// Creates a key for a tenant. The full key is returned ONCE and never stored:
// the database only keeps its hash, so a lost key can't be looked up again.
export async function createApiKey(tenantId: string, name: string) {
  const key = generateKey();
  const row = await asTenant(tenantId, (tx) =>
    tx.api_keys.create({
      data: { tenant_id: tenantId, name, key_prefix: key.slice(0, 12), key_hash: hashKey(key) },
      select: { id: true },
    })
  );
  return { id: row.id, key, prefix: key.slice(0, 12) };
}

// Turns a presented key into a tenant, or null. Runs before any tenant is
// known, so it goes through the one narrow database function built for it.
export async function authenticate(key: string): Promise<{ tenantId: string; keyId: string } | null> {
  if (!KEY_RE.test(key)) return null;
  const rows = await prisma.$queryRaw<{ tenant_id: string; key_id: string }[]>`
    select tenant_id, key_id from authenticate_api_key(${hashKey(key)})`;
  const r = rows[0];
  return r ? { tenantId: r.tenant_id, keyId: r.key_id } : null;
}

export async function revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
  const r = await asTenant(tenantId, (tx) =>
    tx.api_keys.updateMany({ where: { id: keyId, revoked_at: null }, data: { revoked_at: new Date() } })
  );
  return r.count === 1;
}