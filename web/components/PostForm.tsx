"use client";

import { useState } from "react";
import { StatusBadge } from "./Health";
import { api } from "@/lib/api";
import { currencySymbol, formatMoney, parseAmount, toInput } from "@/lib/format";
import type { Account, PostResult, Side } from "@/lib/types";

type Line = { id: number; account: string; direction: Side; amount: string };

let counter = 1;
const newLine = (account: string, direction: Side): Line => ({ id: counter++, account, direction, amount: "" });
const newReference = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ZERO = BigInt(0);

export function PostForm({ accounts, onPosted }: { accounts: Account[]; onPosted: () => void }) {
  const first = accounts[0]?.code ?? "";
  const second = accounts[1]?.code ?? first;

  const [lines, setLines] = useState<Line[]>(() => [newLine(first, "debit"), newLine(second, "credit")]);
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState(newReference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<PostResult | null>(null);

  const parsed = lines.map((l) => parseAmount(l.amount));
  let debit = ZERO;
  let credit = ZERO;
  lines.forEach((l, i) => {
    const v = parsed[i];
    if (v === null) return;
    if (l.direction === "debit") debit += v;
    else credit += v;
  });

  const currency = accounts.find((a) => a.code === lines[0]?.account)?.currency ?? "NGN";
  const allValid = lines.length >= 2 && lines.every((l, i) => l.account !== "" && parsed[i] !== null);
  const balanced = debit > ZERO && debit === credit;
  const canPost = allValid && balanced && !busy && !receipt;
  const diff = debit > credit ? debit - credit : credit - debit;
  const touched = debit > ZERO || credit > ZERO;
  const hasSalePreset = Boolean(accounts.find((a) => a.code === "1000") && accounts.find((a) => a.code === "4000"));

  function patch(id: number, change: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...change } : l)));
  }

  function reset(nextLines?: Line[], nextDescription = "") {
    setLines(nextLines ?? [newLine(first, "debit"), newLine(second, "credit")]);
    setDescription(nextDescription);
    setReference(newReference());
    setReceipt(null);
    setError("");
  }

  function preset(kind: "sale" | "refund") {
    const [a, b] = kind === "sale" ? ["1000", "4000"] : ["4000", "1000"];
    reset([newLine(a, "debit"), newLine(b, "credit")], kind === "sale" ? "Cash sale" : "Customer refund");
  }

  function fillFor(i: number): bigint {
    const l = lines[i];
    const own = l.direction === "debit" ? debit : credit;
    const other = l.direction === "debit" ? credit : debit;
    const need = other - (own - (parsed[i] ?? ZERO));
    return need > ZERO ? need : ZERO;
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await api<PostResult>("transactions", {
        method: "POST",
        body: {
          idempotencyKey: reference,
          description: description.trim() || undefined,
          lines: lines.map((l, i) => ({ account: l.account, direction: l.direction, amount: (parsed[i] as bigint).toString() })),
        },
      });
      setReceipt(res);
      onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form-card">
      <header className="card-head">
        <div>
          <h3 className="card-title">Entry details</h3>
          <p className="card-sub">Every entry needs debits and credits that add up to the same amount.</p>
        </div>
        {hasSalePreset && (
          <div className="presets">
            <button type="button" className="btn ghost small" onClick={() => preset("sale")}>
              Cash sale
            </button>
            <button type="button" className="btn ghost small" onClick={() => preset("refund")}>
              Customer refund
            </button>
          </div>
        )}
      </header>

      <div className="sums" aria-live="polite">
        <div className="sum">
          <span className="sum-label">
            <span className="swatch" style={{ background: "var(--series-1)" }} />
            Debits
          </span>
          <span className="sum-val">{formatMoney(debit, currency)}</span>
        </div>
        <div className="sum">
          <span className="sum-label">
            <span className="swatch" style={{ background: "var(--series-2)" }} />
            Credits
          </span>
          <span className="sum-val">{formatMoney(credit, currency)}</span>
        </div>
        <div className="sum status">
          {balanced ? (
            <StatusBadge ok yes="Balanced" no="" />
          ) : touched ? (
            <span className="muted">
              Off by <strong className="ink">{formatMoney(diff, currency)}</strong>. Add it to the {debit > credit ? "credit" : "debit"} side.
            </span>
          ) : (
            <span className="muted">Enter an amount to begin.</span>
          )}
        </div>
      </div>

      <label className="stack">
        <span className="label">Description</span>
        <input className="field" value={description} maxLength={200} placeholder="What happened, e.g. Invoice 1042 paid" onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="lines">
        {lines.map((l, i) => {
          const fill = fillFor(i);
          return (
            <div className="line" key={l.id}>
              <select className="field" value={l.account} aria-label={`Account for line ${i + 1}`} onChange={(e) => patch(l.id, { account: e.target.value })}>
                {accounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>

              <div className="seg" role="group" aria-label={`Side for line ${i + 1}`}>
                <button type="button" aria-pressed={l.direction === "debit"} onClick={() => patch(l.id, { direction: "debit" })}>
                  Debit
                </button>
                <button type="button" aria-pressed={l.direction === "credit"} onClick={() => patch(l.id, { direction: "credit" })}>
                  Credit
                </button>
              </div>

              <div className="amtcol">
                <div className="amt">
                  <span className="cur">{currencySymbol(currency).trim()}</span>
                  <input
                    className="field num"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={l.amount}
                    aria-label={`Amount for line ${i + 1}`}
                    onChange={(e) => patch(l.id, { amount: e.target.value.replace(/[^0-9.,]/g, "") })}
                  />
                </div>
                {fill > ZERO && fill !== (parsed[i] ?? ZERO) && (
                  <button type="button" className="linkbtn" onClick={() => patch(l.id, { amount: toInput(fill) })}>
                    Use {formatMoney(fill, currency)} to balance
                  </button>
                )}
              </div>

              <button type="button" className="icon-btn" aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}>
                ×
              </button>
            </div>
          );
        })}
        <button type="button" className="linkbtn" disabled={lines.length >= 6} onClick={() => setLines((ls) => [...ls, newLine(first, "debit")])}>
          Add a line
        </button>
      </div>

      <label className="stack">
        <span className="label">Reference</span>
        <input className="field mono" value={reference} maxLength={128} onChange={(e) => setReference(e.target.value)} />
        <span className="hint">Posting the same reference twice never books the entry twice, so retries are safe.</span>
      </label>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {receipt && (
        <div className="notice" role="status">
          <strong>{receipt.replayed ? "Already posted." : "Posted."}</strong>{" "}
          {receipt.replayed ? "This reference was used before, so nothing new was written." : "The entry is in the ledger and the dashboard has updated."}
          <div className="txid">Transaction {receipt.transactionId}</div>
        </div>
      )}

      <div className="actions">
        <button type="button" className="btn" disabled={!canPost} onClick={submit}>
          {busy ? "Posting…" : "Post entry"}
        </button>
        {(receipt || touched) && (
          <button type="button" className="btn ghost" onClick={() => reset()}>
            {receipt ? "Start a new entry" : "Clear"}
          </button>
        )}
      </div>
    </section>
  );
}
