"use client";

import type { Recon } from "@/lib/types";

const PLAIN: Record<string, string> = {
  "every transaction balances per currency": "Debits equal credits inside every transaction.",
  "every transaction has at least 2 entries": "No transaction is missing its other side.",
  "processed webhook events match their postings": "Each payment event posted exactly the amount the provider reported.",
  "no webhook events are dead, failing or stuck": "No incoming payment event is stuck or has given up.",
};

const SHORT: Record<string, string> = {
  "every transaction balances per currency": "Transactions balance",
  "every transaction has at least 2 entries": "Both sides present",
  "processed webhook events match their postings": "Payments match postings",
  "no webhook events are dead, failing or stuck": "No stuck payment events",
};

// Status never relies on color alone: every state has an icon and a word.
export function StatusIcon({ ok }: { ok: boolean }) {
  return (
    <svg className={`status-icon ${ok ? "good" : "crit"}`} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      {ok ? (
        <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="var(--on-status)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" fill="none" stroke="var(--on-status)" strokeWidth="2.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function StatusBadge({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return (
    <span className={`badge ${ok ? "good" : "crit"}`}>
      <StatusIcon ok={ok} />
      {ok ? yes : no}
    </span>
  );
}

export function HealthPanel({ recon, onOpen }: { recon: Recon | null; onOpen: () => void }) {
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h3 className="card-title">Ledger health</h3>
          <p className="card-sub">Checks run against the raw entries</p>
        </div>
      </header>
      {!recon && <p className="muted">Running checks…</p>}
      {recon && (
        <>
          <StatusBadge ok={recon.ok} yes="All checks passed" no="Needs attention" />
          <ul className="mini-checks">
            {recon.checks.map((c) => (
              <li key={c.name}>
                <StatusIcon ok={c.ok} />
                <span>{SHORT[c.name] ?? c.name}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="linkbtn" onClick={onOpen}>
            See details
          </button>
        </>
      )}
    </section>
  );
}

export function HealthPage({ recon, onRerun }: { recon: Recon | null; onRerun: () => void }) {
  if (!recon) return <p className="muted pad">Running checks…</p>;
  const passed = recon.checks.filter((c) => c.ok).length;
  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h3 className="card-title">{recon.ok ? "Everything checks out" : "Something needs attention"}</h3>
          <p className="card-sub">
            {passed} of {recon.checks.length} checks passed. They re-read the raw entries instead of trusting stored totals.
          </p>
        </div>
        <button type="button" className="btn ghost" onClick={onRerun}>
          Run checks again
        </button>
      </header>
      <ul className="checks">
        {recon.checks.map((c) => (
          <li key={c.name} className="check">
            <StatusIcon ok={c.ok} />
            <div>
              <div className="check-name">{c.name}</div>
              <div className="muted">
                {PLAIN[c.name] ?? ""} {!c.ok && <strong className="crit-text">{c.count} found.</strong>}
              </div>
              {c.samples.length > 0 && (
                <details>
                  <summary>Show examples</summary>
                  <pre>{JSON.stringify(c.samples, null, 2)}</pre>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
