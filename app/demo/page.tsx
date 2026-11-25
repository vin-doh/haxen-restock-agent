import type { Metadata } from "next";
import sample from "../../data/sample-inventory.json" with { type: "json" };
import DemoClient from "./DemoClient.tsx";

export const metadata: Metadata = { title: "Try a restock · HaxenMed Restock Agent" };

export default function DemoPage() {
  const items = sample.items.map((i) => ({ sku: i.sku, name: i.name, stock: i.stock, reorderLevel: i.reorderLevel, dailySales: i.dailySales }));
  return (
    <section>
      <h1 style={{ fontSize: 32, margin: "8px 0 8px", letterSpacing: "-0.02em" }}>Try a restock</h1>
      <p className="lead">
        This runs the agent's real planner, ledger, payment code and reconciler. The wallet, Textile and the chain are simulated, so
        no real money moves. The exchange rate is Textile's live price. Pick something to go wrong and watch how the agent handles it.
      </p>
      <DemoClient items={items} />
    </section>
  );
}
