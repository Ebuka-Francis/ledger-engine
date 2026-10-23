"use client";

import { Drawer } from "./Drawer";
import { StatusBadge } from "./Health";
import { formatMoney, formatWhen } from "@/lib/format";
import type { Statement, TrialBalance } from "@/lib/types";

export function AccountsPage({
  tb,
  asOf,
  onAsOf,
  onOpen,
}: {
  tb: TrialBalance | null;
  asOf: string;
  onAsOf: (v: string) => void;
  onOpen: (code: string) => void;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h3 className="card-title">Trial balance</h3>
          <p className="card-sub">Every account with its total debits and credits. If the books are right, both totals match.</p>
        </div>
        <div className="asof">
          <label>
            As of
            <input type="datetime-local" className="field small" value={asOf} onChange={(e) => onAsOf(e.target.value)} />
          </label>
          {asOf && (
            <button type="button" className="btn ghost small" onClick={() => onAsOf("")}>
              Back to now
            </button>
          )}
        </div>
      </header>

      {!tb && <p className="muted pad">Loading balances…</p>}
      {tb && tb.accounts.length === 0 && <p className="empty">No accounts yet.</p>}
      {tb && tb.accounts.length > 0 && (
        <div className="tbl-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Account</th>
                <th>Type</th>
                <th className="num">Debits</th>
                <th className="num">Credits</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {tb.accounts.map((a) => (
                <tr
                  key={a.code}
                  className="click"
                  tabIndex={0}
                  aria-label={`Open statement for ${a.name}`}
                  onClick={() => onOpen(a.code)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(a.code);
                    }
                  }}
                >
                  <td className="code">{a.code}</td>
                  <td>{a.name}</td>
                  <td className="cap muted">{a.type}</td>
                  <td className="num">{formatMoney(a.debits, a.currency)}</td>
                  <td className="num">{formatMoney(a.credits, a.currency)}</td>
                  <td className="num strong">{formatMoney(a.balance, a.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {tb.totals.map((t) => (
                <tr key={t.currency}>
                  <td colSpan={3}>
                    Total ({t.currency}) <StatusBadge ok={t.balanced} yes="Balanced" no="Out of balance" />
                  </td>
                  <td className="num">{formatMoney(t.debits, t.currency)}</td>
                  <td className="num">{formatMoney(t.credits, t.currency)}</td>
                  <td />
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}
      {tb && tb.accounts.length > 0 && <p className="hint">Select an account to open its statement.</p>}
    </section>
  );
}

export function AccountDrawer({
  name,
  code,
  statement,
  onClose,
  onOpenTx,
}: {
  name: string;
  code: string;
  statement: Statement | undefined;
  onClose: () => void;
  onOpenTx: (id: string) => void;
}) {
  const cur = statement?.currency ?? "NGN";
  const rows = statement ? [...statement.lines].reverse() : [];
  return (
    <Drawer title={name} sub={`Account ${code}, newest first`} onClose={onClose}>
      {!statement && <p className="muted">Loading statement…</p>}
      {statement && rows.length === 0 && <p className="empty">Nothing has been posted to this account yet.</p>}
      {rows.length > 0 && (
        <div className="tbl-scroll">
          <table className="data compact">
            <thead>
              <tr>
                <th>When</th>
                <th>Description</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l, i) => (
                <tr
                  key={i}
                  className="click"
                  tabIndex={0}
                  onClick={() => onOpenTx(l.transactionId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenTx(l.transactionId);
                    }
                  }}
                >
                  <td className="nowrap">{formatWhen(l.postedAt)}</td>
                  <td>{l.description ?? <span className="muted">No description</span>}</td>
                  <td className="num">{l.direction === "debit" ? formatMoney(l.amount, cur) : ""}</td>
                  <td className="num">{l.direction === "credit" ? formatMoney(l.amount, cur) : ""}</td>
                  <td className="num strong">{formatMoney(l.balance, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {statement?.hasMore && <p className="hint">Showing the first 500 movements.</p>}
      {rows.length > 0 && <p className="hint">Select a line to see both sides of its transaction.</p>}
    </Drawer>
  );
}
