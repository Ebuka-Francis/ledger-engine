import type { Account, Recon, Side, Statement, TrialBalance } from "./types";

// Everything the dashboard shows is computed from data the API already returns
// (trial balance + one statement per account). No extra endpoints needed.

export type DashData = {
  accounts: Account[];
  tb: TrialBalance | null;
  recon: Recon | null;
  statements: Record<string, Statement>;
  txs: TxView[];
};

export type TxLeg = { account: string; direction: Side; amount: string };
export type TxView = { id: string; at: number; description: string | null; legs: TxLeg[]; total: bigint };
export type Point = { t: number; v: number };
export type DayBucket = { day: number; inflow: number; outflow: number };

export const DAY = 86_400_000;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildTransactions(statements: Record<string, Statement>): TxView[] {
  const map = new Map<string, TxView>();
  for (const [code, st] of Object.entries(statements)) {
    for (const l of st.lines) {
      let tx = map.get(l.transactionId);
      if (!tx) {
        tx = { id: l.transactionId, at: new Date(l.postedAt).getTime(), description: l.description, legs: [], total: BigInt(0) };
        map.set(l.transactionId, tx);
      }
      tx.legs.push({ account: code, direction: l.direction, amount: l.amount });
      if (l.direction === "debit") tx.total += BigInt(l.amount);
    }
  }
  return [...map.values()].sort((a, b) => b.at - a.at);
}

// Balance after every posting inside [from, now]. The balance holds until the
// next posting, so charts draw it as steps.
export function balanceSeries(st: Statement, from: number, now: number): Point[] {
  let before = 0;
  const pts: Point[] = [];
  for (const l of st.lines) {
    const t = new Date(l.postedAt).getTime();
    const v = Number(l.balance) / 100;
    if (t < from) before = v;
    else if (t <= now) pts.push({ t, v });
  }
  const last = pts.length ? pts[pts.length - 1].v : before;
  return [{ t: from, v: before }, ...pts, { t: now, v: last }];
}

// Money in = debits to an asset account like Cash; money out = credits.
export function dailyFlows(st: Statement, from: number, now: number): DayBucket[] {
  const buckets = new Map<number, DayBucket>();
  for (let t = startOfDay(from); t <= now; ) {
    buckets.set(t, { day: t, inflow: 0, outflow: 0 });
    const d = new Date(t);
    d.setDate(d.getDate() + 1);
    t = d.getTime();
  }
  for (const l of st.lines) {
    const t = new Date(l.postedAt).getTime();
    if (t < from || t > now) continue;
    const b = buckets.get(startOfDay(t));
    if (!b) continue;
    const v = Number(l.amount) / 100;
    if (l.direction === "debit") b.inflow += v;
    else b.outflow += v;
  }
  return [...buckets.values()];
}

export function pickAccounts(accounts: Account[]) {
  const assets = accounts.filter((a) => a.type === "asset");
  return {
    cash: assets.find((a) => a.code === "1000") ?? assets[0],
    revenue: accounts.find((a) => a.type === "revenue"),
  };
}
