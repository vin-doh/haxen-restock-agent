"use client";

import { useEffect, useState } from "react";

type Item = { sku: string; name: string; stock: number; reorderLevel: number; dailySales: number };
type Finding = { level: "ok" | "warn" | "error"; message: string };
type Result = {
  scenario: string;
  ngnPerUsd: number;
  rateIsLive: boolean;
  orders: Array<{ id: string; supplier: string; total: string; lines: Array<{ name: string; qty: number; reason: string; lineTotal: string }> }>;
  steps: Array<{ kind: string; text: string; tx?: string }>;
  payments: Array<{ id: string; order: string; state: string; amount: string; usdtSpent: string | null; swapTx: string | null; payTx: string | null; error: string | null; events: Array<{ from: string | null; to: string; detail: string | null }> }>;
  ledger: Array<{ account: string; currency: string; balance: string }>;
  reconcile: { findings: Finding[]; balances: Array<{ currency: string; ledger: string; chain: string }> };
  supplierReceived: string;
  transactionsSent: number;
  error?: string;
};

const SCENARIOS: Array<[string, string, string]> = [
  ["normal", "Everything works", "Quote, approve, swap, pay, reconcile."],
  ["crash_after_swap", "Connection drops after the swap", "Did the swap happen? The agent asks Textile instead of guessing."],
  ["crash_after_transfer", "Connection drops after paying", "The agent finds the transfer onchain and does not pay again."],
  ["transfer_lost", "The payment never lands", "The agent waits for confirmations, sees nothing, then pays once."],
  ["cap_hit", "Owner's daily cap too small", "The chain refuses; the payment stops until the owner acts."],
  ["revoked", "Owner revoked the agent", "Every call is refused. Nothing moves."],
];

const stateClass = (s: string) =>
  s === "PAID" || s === "RECONCILED" || s === "SWAPPED" ? "ok" : s === "BLOCKED" ? "warn" : s === "FAILED" ? "err" : "info";
const kindLabel: Record<string, string> = { plan: "Plan", log: "Agent", chain: "Chain", owner: "Owner", recover: "Recovery", result: "Result" };

export default function DemoClient({ items }: { items: Item[] }) {
  const [scenario, setScenario] = useState("normal");
  const [stock, setStock] = useState<Record<string, number>>(Object.fromEntries(items.map((i) => [i.sku, i.stock])));
  const [perOrder, setPerOrder] = useState(60);
  const [perRun, setPerRun] = useState(100);
  const [rate, setRate] = useState<{ ngnPerUsd: number; live: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/demo")
      .then((r) => r.json())
      .then((d) => setRate({ ngnPerUsd: d.ngnPerUsd, live: d.live }))
      .catch(() => setRate(null));
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, stock, maxUsdtPerOrder: perOrder, maxUsdtPerRun: perRun }),
      });
      const data = (await res.json()) as Result;
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="demo">
      <div className="card panel">
        <h3>What goes wrong?</h3>
        {SCENARIOS.map(([id, title, hint]) => (
          <label key={id} className="radio">
            <input type="radio" name="scenario" value={id} checked={scenario === id} onChange={() => setScenario(id)} />
            <span>
              <strong>{title}</strong>
              <br />
              <span style={{ color: "var(--muted)" }}>{hint}</span>
            </span>
          </label>
        ))}

        <h3 style={{ marginTop: 16 }}>Stock on hand</h3>
        {items.map((i) => (
          <div key={i.sku} className="stockrow">
            <span>
              {i.name}
              <br />
              <span style={{ color: "var(--muted)", fontSize: 12 }}>reorder at {i.reorderLevel}, sells {i.dailySales}/day</span>
            </span>
            <input
              type="number"
              min={0}
              max={10000}
              aria-label={`${i.name} on hand`}
              value={stock[i.sku] ?? 0}
              onChange={(e) => setStock({ ...stock, [i.sku]: Math.max(0, Number(e.target.value) || 0) })}
            />
          </div>
        ))}

        <label className="field">
          Agent's per-order limit (USD₮)
          <small>The agent stops before quoting anything bigger.</small>
        </label>
        <input type="number" min={0} value={perOrder} onChange={(e) => setPerOrder(Number(e.target.value) || 0)} />
        <label className="field">Agent's per-run limit (USD₮)</label>
        <input type="number" min={0} value={perRun} onChange={(e) => setPerRun(Number(e.target.value) || 0)} />

        <p style={{ fontSize: 13, color: "var(--muted)", margin: "14px 0" }}>
          {rate ? (
            <>Priced at {rate.live ? "Textile's live rate" : "a fixed fallback rate"}: ₦{rate.ngnPerUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })} per USD₮.</>
          ) : (
            "Fetching Textile's live rate…"
          )}
        </p>
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center" }} onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run restock (simulated)"}
        </button>
      </div>

      <div>
        {error && <div className="callout warn">Could not run: {error}</div>}
        {!result && !error && <div className="empty">Pick a scenario and press Run. The result shows every step the agent took, the money it moved, and whether its books match the chain.</div>}
        {result && <ResultView r={result} />}
      </div>
    </div>
  );
}

function ResultView({ r }: { r: Result }) {
  const errors = r.reconcile.findings.filter((f) => f.level === "error").length;
  const match = r.reconcile.balances.every((b) => b.ledger === b.chain);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="stats">
        <div className="card"><div style={{ color: "var(--muted)", fontSize: 13 }}>Supplier received</div><div className="big">{r.supplierReceived}</div></div>
        <div className="card"><div style={{ color: "var(--muted)", fontSize: 13 }}>Transactions sent</div><div className="big">{r.transactionsSent}</div></div>
        <div className="card">
          <div style={{ color: "var(--muted)", fontSize: 13 }}>Books vs chain</div>
          <div className="big" style={{ color: match && errors === 0 ? "var(--ok)" : "var(--err)" }}>{match && errors === 0 ? "Match" : "Mismatch"}</div>
        </div>
      </div>

      {r.orders.length === 0 && <div className="empty">Nothing is at or below its reorder point, so the agent orders nothing.</div>}
      {r.orders.map((o) => (
        <div key={o.id} className="card">
          <h3>
            Order <span className="mono">{o.id}</span> · {o.supplier}
          </h3>
          <div className="scroll">
            <table>
              <thead><tr><th>Item</th><th>Qty</th><th>Why</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
              <tbody>
                {o.lines.map((l) => (
                  <tr key={l.name}><td>{l.name}</td><td>{l.qty}</td><td style={{ color: "var(--muted)" }}>{l.reason}</td><td className="num">{l.lineTotal}</td></tr>
                ))}
                <tr><td colSpan={3}><strong>Order total</strong></td><td className="num"><strong>{o.total}</strong></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {r.payments.map((p) => (
        <div key={p.id} className="card">
          <h3>
            Payment <span className={`chip ${stateClass(p.state)}`}>{p.state}</span>
          </h3>
          <div className="states">
            {p.events.map((e, i) => (
              <span key={i} style={{ display: "contents" }}>
                {i > 0 && <span className="arrow">→</span>}
                <span className={`chip ${stateClass(e.to)}`} title={e.detail ?? ""}>{e.to}</span>
              </span>
            ))}
          </div>
          <p style={{ margin: "6px 0", color: "var(--muted)", fontSize: 14 }}>
            {p.amount} to the supplier{p.usdtSpent ? `, paid for with ${p.usdtSpent}` : ""}.
            {p.error ? <> Stopped because: {p.error}</> : null}
          </p>
        </div>
      ))}

      <div className="card">
        <h3>Every step</h3>
        <ol className="timeline">
          {r.steps.map((s, i) => (
            <li key={i}>
              <span className="k">{kindLabel[s.kind] ?? s.kind}</span>
              <span>
                {s.text}
                {s.tx && <div className="hash">simulated tx {s.tx}</div>}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="card">
        <h3>Reconciliation</h3>
        <ul className="timeline">
          {r.reconcile.findings.map((f, i) => (
            <li key={i}>
              <span><span className={`chip ${f.level === "ok" ? "ok" : f.level === "warn" ? "warn" : "err"}`}>{f.level.toUpperCase()}</span></span>
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>The books (double-entry)</h3>
        <p style={{ color: "var(--muted)", fontSize: 14, margin: "0 0 8px" }}>Each currency's balances sum to zero. The wallet's balances match the simulated chain.</p>
        <div className="scroll">
          <table>
            <thead><tr><th>Account</th><th style={{ textAlign: "right" }}>Balance</th></tr></thead>
            <tbody>
              {r.ledger.map((b) => (
                <tr key={b.account + b.currency}><td className="mono">{b.account}</td><td className="num">{b.balance}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
