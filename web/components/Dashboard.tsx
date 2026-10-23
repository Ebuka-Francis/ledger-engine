"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { buildTransactions, type DashData } from "@/lib/derive";
import type { Account, Recon, Statement, TrialBalance } from "@/lib/types";
import { AccountDrawer, AccountsPage } from "./Accounts";
import { HealthPage } from "./Health";
import { Overview } from "./Overview";
import { PostForm } from "./PostForm";
import { TransactionsPage, TxDrawer } from "./Transactions";

type Page = "overview" | "transactions" | "accounts" | "post" | "health";
type Status = "waking" | "ready" | "failed";
type DrawerState = { kind: "account"; code: string } | { kind: "tx"; id: string } | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

const NAV: { id: Page; label: string; title: string; sub: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", title: "Overview", sub: "Balances, movement and ledger health at a glance", icon: icon(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>) },
  { id: "transactions", label: "Transactions", title: "Transactions", sub: "Everything posted to the ledger", icon: icon(<><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>) },
  { id: "accounts", label: "Accounts", title: "Accounts", sub: "Trial balance and account statements", icon: icon(<><path d="M4 4.5A2.5 2.5 0 016.5 2H20v17H6.5A2.5 2.5 0 004 21.5z" /><path d="M4 21.5A2.5 2.5 0 016.5 19H20v3H6.5A2.5 2.5 0 014 21.5z" /></>) },
  { id: "post", label: "New entry", title: "New entry", sub: "Record a transaction in the ledger", icon: icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>) },
  { id: "health", label: "Ledger health", title: "Ledger health", sub: "Independent checks on the books", icon: icon(<><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>) },
];

export default function Dashboard() {
  const [status, setStatus] = useState<Status>("waking");
  const [page, setPage] = useState<Page>("overview");
  const [days, setDays] = useState(30);
  const [asOf, setAsOf] = useState("");
  const [version, setVersion] = useState(0);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [recon, setRecon] = useState<Recon | null>(null);
  const [statements, setStatements] = useState<Record<string, Statement>>({});
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    try {
      const t = localStorage.getItem("theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {}
  }, []);

  function toggleTheme() {
    const current = theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  }

  // The free host sleeps when idle. Knock on /health until it answers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 20 && !cancelled; i++) {
        try {
          await api("health");
          if (!cancelled) setStatus("ready");
          return;
        } catch {
          await sleep(3000);
        }
      }
      if (!cancelled) setStatus("failed");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Accounts, checks and one statement per account. Charts and the transaction
  // list are all computed from these.
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const [a, r] = await Promise.all([api<{ accounts: Account[] }>("accounts"), api<Recon>("reports/reconciliation")]);
        const list = a.accounts.slice(0, 8);
        const sts = await Promise.all(list.map((acc) => api<Statement>(`accounts/${encodeURIComponent(acc.code)}/statement?limit=500`)));
        if (cancelled) return;
        const map: Record<string, Statement> = {};
        list.forEach((acc, i) => (map[acc.code] = sts[i]));
        setAccounts(a.accounts);
        setRecon(r);
        setStatements(map);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load data");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, version]);

  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    const q = asOf ? `?asOf=${encodeURIComponent(new Date(asOf).toISOString())}` : "";
    api<TrialBalance>(`reports/trial-balance${q}`)
      .then((d) => !cancelled && setTb(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [status, asOf, version]);

  const txs = useMemo(() => buildTransactions(statements), [statements]);
  const data: DashData = { accounts, tb, recon, statements, txs };
  const nameOf = useCallback((code: string) => accounts.find((a) => a.code === code)?.name ?? code, [accounts]);
  const currency = accounts[0]?.currency ?? "NGN";
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const current = NAV.find((n) => n.id === page) ?? NAV[0];
  const loaded = recon !== null;
  const openTx = (id: string) => setDrawer({ kind: "tx", id });
  const drawerTx = drawer?.kind === "tx" ? txs.find((t) => t.id === drawer.id) : undefined;

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M3 8h26M16 8v21" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
          </svg>
          <span>Ledger Engine</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <button key={n.id} type="button" className="nav-item" aria-current={page === n.id ? "page" : undefined} onClick={() => setPage(n.id)}>
              {n.icon}
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="status" role="status">
            <span className={`dot ${status === "ready" ? "on" : status === "waking" ? "wake" : "bad"}`} />
            {status === "ready" ? "Server awake" : status === "waking" ? "Waking the server" : "Server unreachable"}
          </span>
          <a href="https://github.com/Ebuka-Francis/ledger-engine" target="_blank" rel="noreferrer">
            Source code
          </a>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h1>{current.title}</h1>
            <p className="muted">{current.sub}</p>
          </div>
          <div className="top-actions">
            <button type="button" className="icon-btn theme" onClick={toggleTheme} aria-label="Switch between light and dark mode">
              <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
              <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
              </svg>
            </button>
            {page !== "post" && (
              <button type="button" className="btn" onClick={() => setPage("post")}>
                New entry
              </button>
            )}
          </div>
        </header>

        {status === "waking" && (
          <div className="card waking">
            <h2>Waking the ledger server</h2>
            <p className="muted">The free host puts the server to sleep when nobody is using it. It takes up to a minute to start, then everything loads.</p>
            <div className="bar" />
          </div>
        )}

        {status === "failed" && (
          <div className="card waking">
            <h2>The server did not respond</h2>
            <p className="muted">Check that the backend is running, then try again.</p>
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        )}

        {status === "ready" && (
          <>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
            {!loaded && !error && <p className="muted pad">Loading your ledger…</p>}
            {loaded && page === "overview" && (
              <Overview data={data} days={days} onDays={setDays} onNav={setPage} onOpenTx={openTx} nameOf={nameOf} />
            )}
            {loaded && page === "transactions" && <TransactionsPage txs={txs} nameOf={nameOf} currency={currency} onOpen={openTx} />}
            {loaded && page === "accounts" && <AccountsPage tb={tb} asOf={asOf} onAsOf={setAsOf} onOpen={(code) => setDrawer({ kind: "account", code })} />}
            {loaded && page === "post" && (accounts.length > 0 ? <PostForm accounts={accounts} onPosted={refresh} /> : <p className="muted pad">Loading accounts…</p>)}
            {loaded && page === "health" && <HealthPage recon={recon} onRerun={refresh} />}
          </>
        )}

        <footer className="foot">A shared demo workspace: entries posted here are visible to everyone who opens this page.</footer>
      </div>

      {drawer?.kind === "account" && (
        <AccountDrawer name={nameOf(drawer.code)} code={drawer.code} statement={statements[drawer.code]} onClose={closeDrawer} onOpenTx={openTx} />
      )}
      {drawerTx && <TxDrawer tx={drawerTx} nameOf={nameOf} currency={currency} onClose={closeDrawer} />}
    </div>
  );
}
