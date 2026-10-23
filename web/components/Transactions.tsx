"use client";

import { useState } from "react";
import { Drawer } from "./Drawer";
import { formatMoney, formatWhen } from "@/lib/format";
import type { TxView } from "@/lib/derive";

type NameOf = (code: string) => string;

function route(tx: TxView, nameOf: NameOf): string {
  const uniq = (dir: "debit" | "credit") => [...new Set(tx.legs.filter((l) => l.direction === dir).map((l) => nameOf(l.account)))];
  return `${uniq("credit").join(", ")} to ${uniq("debit").join(", ")}`;
}

export function TxTable({
  txs,
  nameOf,
  currency,
  onOpen,
}: {
  txs: TxView[];
  nameOf: NameOf;
  currency: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="tbl-scroll">
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Description</th>
            <th>Moved</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t) => (
            <tr
              key={t.id}
              className="click"
              tabIndex={0}
              aria-label={`Open transaction ${t.description ?? t.id}`}
              onClick={() => onOpen(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(t.id);
                }
              }}
            >
              <td className="nowrap">{formatWhen(new Date(t.at).toISOString())}</td>
              <td>{t.description ?? <span className="muted">No description</span>}</td>
              <td className="muted">{route(t, nameOf)}</td>
              <td className="num">{formatMoney(t.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TransactionsPage({
  txs,
  nameOf,
  currency,
  onOpen,
}: {
  txs: TxView[];
  nameOf: NameOf;
  currency: string;
  onOpen: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? txs.filter(
        (t) =>
          (t.description ?? "").toLowerCase().includes(needle) ||
          t.id.includes(needle) ||
          t.legs.some((l) => l.account.includes(needle) || nameOf(l.account).toLowerCase().includes(needle))
      )
    : txs;

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h3 className="card-title">All transactions</h3>
          <p className="card-sub">
            Showing {shown.length} of {txs.length}
          </p>
        </div>
        <input
          className="field search"
          type="search"
          value={q}
          placeholder="Search description or account"
          aria-label="Search transactions"
          onChange={(e) => setQ(e.target.value)}
        />
      </header>
      {shown.length === 0 ? (
        <p className="empty">{txs.length === 0 ? "Nothing posted yet. Post the first entry from New entry." : "No transactions match that search."}</p>
      ) : (
        <TxTable txs={shown} nameOf={nameOf} currency={currency} onOpen={onOpen} />
      )}
    </section>
  );
}

export function TxDrawer({ tx, nameOf, currency, onClose }: { tx: TxView; nameOf: NameOf; currency: string; onClose: () => void }) {
  const debit = tx.legs.filter((l) => l.direction === "debit");
  const credit = tx.legs.filter((l) => l.direction === "credit");
  return (
    <Drawer title={tx.description ?? "Transaction"} sub={formatWhen(new Date(tx.at).toISOString())} onClose={onClose}>
      <p className="muted pad-b">Every transaction has two sides that match. These are both of them.</p>
      <table className="data">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {[...debit, ...credit].map((l, i) => (
            <tr key={i}>
              <td>
                <span className="code">{l.account}</span> {nameOf(l.account)}
              </td>
              <td className="num">{l.direction === "debit" ? formatMoney(l.amount, currency) : ""}</td>
              <td className="num">{l.direction === "credit" ? formatMoney(l.amount, currency) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td className="num">{formatMoney(tx.total, currency)}</td>
            <td className="num">{formatMoney(tx.total, currency)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="txid">Transaction {tx.id}</p>
    </Drawer>
  );
}
