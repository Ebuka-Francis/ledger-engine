"use client";

import type { ReactNode } from "react";
import { AreaChart, BalanceTable, ChartCard, EmptyChart, FlowChart, FlowLegend, FlowTable, Sparkline } from "./charts";
import { HealthPanel, StatusIcon } from "./Health";
import { TxTable } from "./Transactions";
import { balanceSeries, dailyFlows, DAY, pickAccounts, type DashData, type Point } from "@/lib/derive";
import { formatMoney, formatNumber } from "@/lib/format";

export const RANGES = [7, 30, 90] as const;

function Delta({ change, currency, period }: { change: number; currency: string; period: string }) {
  if (Math.abs(change) < 0.005) return <span className="delta flat">No change {period}</span>;
  const up = change > 0;
  return (
    <span className={`delta ${up ? "good" : "crit"}`}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        {up ? <path d="M6 2l4 6H2z" fill="currentColor" /> : <path d="M6 10L2 4h8z" fill="currentColor" />}
      </svg>
      <span>
        {up ? "Up" : "Down"} {formatNumber(Math.abs(change), currency)} {period}
      </span>
    </span>
  );
}

function Tile({ label, value, foot, spark }: { label: string; value: ReactNode; foot: ReactNode; spark?: Point[] }) {
  return (
    <section className="tile">
      <div className="tile-main">
        <p className="tile-label">{label}</p>
        <p className="tile-value">{value}</p>
        <p className="tile-foot">{foot}</p>
      </div>
      {spark && spark.length > 1 && <Sparkline points={spark} />}
    </section>
  );
}

export function Overview({
  data,
  days,
  onDays,
  onNav,
  onOpenTx,
  nameOf,
}: {
  data: DashData;
  days: number;
  onDays: (d: number) => void;
  onNav: (p: "health" | "transactions") => void;
  onOpenTx: (id: string) => void;
  nameOf: (code: string) => string;
}) {
  const now = Date.now();
  const from = now - days * DAY;
  const period = `in ${days} days`;
  const { cash, revenue } = pickAccounts(data.accounts);
  const currency = cash?.currency ?? data.accounts[0]?.currency ?? "NGN";

  const cashSt = cash ? data.statements[cash.code] : undefined;
  const revSt = revenue ? data.statements[revenue.code] : undefined;
  const cashSeries = cashSt ? balanceSeries(cashSt, from, now) : null;
  const revSeries = revSt ? balanceSeries(revSt, from, now) : null;
  const flows = cashSt ? dailyFlows(cashSt, from, now) : null;
  const inRange = data.txs.filter((t) => t.at >= from);

  const rowBal = (code?: string) => data.tb?.accounts.find((a) => a.code === code)?.balance;
  const change = (s: Point[] | null) => (s ? s[s.length - 1].v - s[0].v : 0);
  const hasActivity = cashSeries !== null && cashSeries.length > 2;
  const hasFlow = flows !== null && flows.some((d) => d.inflow > 0 || d.outflow > 0);

  return (
    <>
      <div className="filters" role="group" aria-label="Time range">
        <span className="muted">Show</span>
        {RANGES.map((d) => (
          <button key={d} type="button" className="chip" aria-pressed={days === d} onClick={() => onDays(d)}>
            Last {d} days
          </button>
        ))}
      </div>

      <div className="tiles">
        <Tile
          label={cash ? `${cash.name} balance` : "Cash balance"}
          value={rowBal(cash?.code) !== undefined ? formatMoney(rowBal(cash?.code) as string, currency) : "—"}
          foot={cashSeries ? <Delta change={change(cashSeries)} currency={currency} period={period} /> : "No cash account yet"}
          spark={cashSeries ?? undefined}
        />
        <Tile
          label={revenue ? `${revenue.name}` : "Revenue"}
          value={rowBal(revenue?.code) !== undefined ? formatMoney(rowBal(revenue?.code) as string, currency) : "—"}
          foot={revSeries ? <Delta change={change(revSeries)} currency={currency} period={period} /> : "No revenue account yet"}
          spark={revSeries ?? undefined}
        />
        <Tile label="Transactions" value={inRange.length.toLocaleString("en-NG")} foot={`posted ${period}`} />
        <Tile
          label="Ledger health"
          value={
            data.recon ? (
              <span className="tile-status">
                <StatusIcon ok={data.recon.ok} />
                {data.recon.ok ? "All clear" : "Review"}
              </span>
            ) : (
              "…"
            )
          }
          foot={data.recon ? `${data.recon.checks.filter((c) => c.ok).length} of ${data.recon.checks.length} checks passed` : "Running checks"}
        />
      </div>

      <div className="grid-2">
        <ChartCard
          title={cash ? `${cash.name} balance` : "Balance"}
          sub={`Balance after each posting, last ${days} days`}
          table={cashSeries ? <BalanceTable points={cashSeries} currency={currency} /> : null}
        >
          {hasActivity && cashSeries ? (
            <AreaChart points={cashSeries} currency={currency} label={`${cash?.name ?? "Cash"} balance over the last ${days} days`} />
          ) : (
            <EmptyChart>No activity in this period. Try a longer range or post an entry.</EmptyChart>
          )}
        </ChartCard>

        <ChartCard
          title="Money in and out"
          sub={`Daily movement through ${cash?.name ?? "cash"}`}
          legend={<FlowLegend />}
          table={flows ? <FlowTable days={flows} currency={currency} /> : null}
        >
          {hasFlow && flows ? (
            <FlowChart days={flows} currency={currency} label={`Money in and out of ${cash?.name ?? "cash"} per day, last ${days} days`} />
          ) : (
            <EmptyChart>No money moved in this period.</EmptyChart>
          )}
        </ChartCard>
      </div>

      <div className="grid-3">
        <section className="card">
          <header className="card-head">
            <div>
              <h3 className="card-title">Recent transactions</h3>
              <p className="card-sub">Latest postings {period}</p>
            </div>
            <button type="button" className="btn ghost small" onClick={() => onNav("transactions")}>
              View all
            </button>
          </header>
          {inRange.length === 0 ? (
            <p className="empty">No transactions in this period.</p>
          ) : (
            <TxTable txs={inRange.slice(0, 6)} nameOf={nameOf} currency={currency} onOpen={onOpenTx} />
          )}
        </section>
        <HealthPanel recon={data.recon} onOpen={() => onNav("health")} />
      </div>
    </>
  );
}
