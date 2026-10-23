// Money arrives from the API as strings of minor units (kobo). BigInt keeps
// the arithmetic exact; floats would drift.

const ZERO = BigInt(0);
const HUNDRED = BigInt(100);

export function currencySymbol(currency: string): string {
  return currency === "NGN" ? "₦" : `${currency} `;
}

export function formatMoney(minor: string | bigint, currency = "NGN"): string {
  const n = typeof minor === "bigint" ? minor : BigInt(minor);
  const neg = n < ZERO;
  const abs = neg ? -n : n;
  const whole = (abs / HUNDRED).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % HUNDRED).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${currencySymbol(currency)}${whole}.${frac}`;
}

// "1,500.50" -> 150050n. Returns null for blanks, zero, or anything malformed.
export function parseAmount(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[1]) * HUNDRED + BigInt((m[2] ?? "").padEnd(2, "0"));
  return v > ZERO ? v : null;
}

// 150050n -> "1500.50" (for filling an input box)
export function toInput(minor: bigint): string {
  return `${(minor / HUNDRED).toString()}.${(minor % HUNDRED).toString().padStart(2, "0")}`;
}

export function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

// Plain numbers (major units) are used only for drawing charts. Exact money
// shown as text always goes through formatMoney with BigInt.
export function formatNumber(n: number, currency = "NGN"): string {
  return formatMoney(BigInt(Math.round(n * 100)), currency);
}

export function formatCompact(n: number, currency = "NGN"): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const sym = currencySymbol(currency).trim();
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1e9) return `${sign}${sym}${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${sym}${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${sym}${trim(abs / 1e3)}K`;
  return `${sign}${sym}${Math.round(abs)}`;
}

export function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-NG", { day: "numeric", month: "short" }).format(new Date(ms));
}

export function formatDayLong(ms: number): string {
  return new Intl.DateTimeFormat("en-NG", { weekday: "short", day: "numeric", month: "short" }).format(new Date(ms));
}
