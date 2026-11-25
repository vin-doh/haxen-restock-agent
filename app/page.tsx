import Link from "next/link";

export default function Home() {
  return (
    <>
      <section className="hero">
        <div className="tags">
          <span className="tag">Celo mainnet</span>
          <span className="tag">Textile FX · USD₮ → cNGN</span>
          <span className="tag">Altana smart agentic wallet</span>
          <span className="tag">ERC-8004 · ERC-8021</span>
        </div>
        <h1>Keeps a pharmacy stocked. Pays suppliers in their own currency.</h1>
        <p>
          The agent notices what is running low, orders whole cartons, converts US dollars to naira on Textile FX for exactly what the
          supplier is owed, and pays them in cNGN on Celo. It acts from a wallet the pharmacy owner controls, inside limits the
          chain enforces.
        </p>
        <div className="row">
          <Link className="btn btn-primary" href="/demo">Try a restock →</Link>
          <Link className="btn btn-ghost" href="/live">Live on Celo</Link>
        </div>
      </section>

      <section>
        <h2>What it does</h2>
        <div className="grid">
          <div className="card"><div className="step-n">1</div><h3>Reads stock</h3><p>Stock on hand, sales per day, supplier and unit price, from a stock file. Built for HaxenMed, the pharmacy system we run for pharmacies in Ghana.</p></div>
          <div className="card"><div className="step-n">2</div><h3>Plans the reorder</h3><p>Anything at or below its reorder point gets enough whole cartons to cover the supplier's lead time plus two weeks. Every line says why.</p></div>
          <div className="card"><div className="step-n">3</div><h3>Converts on Textile FX</h3><p>A firm quote for exactly the cNGN the supplier invoiced, paid from USD₮. Quotes that deliver less, or point at an unknown contract, are refused.</p></div>
          <div className="card"><div className="step-n">4</div><h3>Pays and reconciles</h3><p>cNGN goes to the supplier's own wallet. Then the agent checks its books against the chain and flags anything it can't explain.</p></div>
        </div>
      </section>

      <section>
        <h2>The owner stays in control</h2>
        <p className="lead">The agent never holds the wallet's key. It holds a session key the owner granted, and the chain refuses anything outside it.</p>
        <div className="grid">
          <div className="card"><h3>Non-custodial wallet</h3><p>An Altana smart agentic wallet. The owner's key controls it; Altana holds no keys.</p></div>
          <div className="card"><h3>Daily caps, allowlist, expiry</h3><p>The session key can only approve USD₮ for Textile, call Textile's settlement contract, and transfer cNGN or USD₮, up to a daily cap per token, until it expires.</p></div>
          <div className="card"><h3>Off in one transaction</h3><p>The owner revokes the key with one transaction. After that, every call the agent makes is refused onchain.</p></div>
          <div className="card"><h3>Its own limits too</h3><p>Per-order and per-run limits stop the agent before it even asks for a quote.</p></div>
        </div>
      </section>

      <section>
        <h2>Built like a payments backend</h2>
        <div className="grid">
          <div className="card"><h3>Double-entry ledger</h3><p>Every movement balances to zero per currency. Integer token units, never floats. Postings can't be edited or deleted.</p></div>
          <div className="card"><h3>Never pays twice</h3><p>The purchase order id is the idempotency key. Re-running, retrying or crashing can't create a second payment.</p></div>
          <div className="card"><h3>Recovers by asking</h3><p>After a crash, it asks Textile whether the swap filled and searches the chain for the transfer, then waits for confirmations before deciding anything never happened.</p></div>
          <div className="card"><h3>Reconciles with the chain</h3><p>Books owner deposits and relay fees, matches every payment, checks the attribution tag, and flags money that left without the agent sending it.</p></div>
        </div>
        <p style={{ marginTop: 18 }}>
          <Link className="btn btn-primary" href="/demo">See it handle a crash →</Link>
        </p>
      </section>
    </>
  );
}
