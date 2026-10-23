// Browser-side helper. It talks to our own Next.js route (/api/ledger/...),
// which adds the API key on the server. The key never reaches the browser.

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api/ledger/${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as
    | { message?: string; error?: string }
    | null;
  if (!res.ok) {
    throw new ApiError(data?.message ?? data?.error ?? `Request failed (${res.status})`, res.status, data?.error);
  }
  return data as T;
}
