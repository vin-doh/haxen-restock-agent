import type { Metadata } from "next";
import type { Address, Hex } from "viem";
import { TOKENS, atomicToWhole } from "../../src/config.ts";
import { TRACKED, hasAttribution, viemChainReader } from "../../src/payments/reconcile.ts";
import { makePublicClient } from "../../src/wallet/altana.ts";

export const metadata: Metadata = { title: "Live on Celo · HaxenMed Restock Agent" };
export const dynamic = "force-dynamic";

const CODE = process.env.ATTRIBUTION_CODE || "celo_3175e01fb588";

export default async function LivePage() {
  const wallet = process.env.AGENT_WALLET as Address | undefined;
  const agentId = process.env.ERC8004_AGENT_ID;
  const startBlock = process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : null;

  return (
    <section>
      <h1 style={{ fontSize: 32, margin: "8px 0 8px", letterSpacing: "-0.02em" }}>Live on Celo</h1>
      <p className="lead">Read straight from Celo mainnet: the agent wallet's balances and every USD₮ and cedi (GHSm) transfer in or out of it, with its attribution tag checked.</p>
      {!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet) ? <NotLiveYet /> : <Live wallet={wallet} agentId={agentId} startBlock={startBlock} />}
    </section>
  );
}

function NotLiveYet() {
  return (
    <div className="callout info">
      <strong>Not live yet.</strong> The agent is built and tested against simulated services, and its Mento cedi pricing and Altana relay
      connection were checked against mainnet without moving money. The first mainnet payment is next. When it happens, this page shows the
      wallet, the ERC-8004 identity and every transaction, read from the chain.
    </div>
  );
}

async function Live({ wallet, agentId, startBlock }: { wallet: Address; agentId?: string; startBlock: bigint | null }) {
  const client = makePublicClient(process.env.CELO_RPC_URL || "https://forno.celo.org");
  const chain = viemChainReader(client);
  let content: React.ReactNode;
  try {
    const [usdt, ghs, head] = await Promise.all([chain.balance("USDT", wallet), chain.balance("GHSm", wallet), chain.blockNumber()]);
    const from = startBlock ?? (head > 200_000n ? head - 200_000n : 0n);
    const logs = (await Promise.all(TRACKED.map((t) => chain.transfers(t, wallet, from, head)))).flat();
    const byTx = new Map<string, typeof logs>();
    for (const l of logs) byTx.set(l.txHash, [...(byTx.get(l.txHash) ?? []), l]);
    const txs = [...byTx.keys()].reverse().slice(0, 25);
    const tagged = new Map<string, boolean>();
    await Promise.all(txs.map(async (h) => tagged.set(h, hasAttribution(await chain.txInput(h as Hex), CODE))));
    content = (
      <>
        <div className="stats">
          <div className="card"><div style={{ color: "var(--muted)", fontSize: 13 }}>USD₮ in wallet</div><div className="big">{atomicToWhole(usdt, 6)}</div></div>
          <div className="card"><div style={{ color: "var(--muted)", fontSize: 13 }}>Cedis (GHSm) in wallet</div><div className="big">{Number(atomicToWhole(ghs, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })}</div></div>
          <div className="card"><div style={{ color: "var(--muted)", fontSize: 13 }}>Transactions found</div><div className="big">{byTx.size}</div></div>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Agent</h3>
          <p>
            Wallet <a className="mono" href={`https://celoscan.io/address/${wallet}`}>{wallet}</a>
            {agentId ? (
              <>
                {" "}· ERC-8004 agent <a href={`https://8004scan.io/agents/celo/${agentId}`}>#{agentId}</a>
              </>
            ) : null}
            {" "}· attribution code <code>{CODE}</code>
          </p>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Transfers since block {from.toString()}</h3>
          {txs.length === 0 ? (
            <div className="empty">No USD₮ or cedi transfers yet.</div>
          ) : (
            <div className="scroll">
              <table>
                <thead><tr><th>Transaction</th><th>Movements</th><th>Tagged</th></tr></thead>
                <tbody>
                  {txs.map((h) => (
                    <tr key={h}>
                      <td><a className="hash" href={`https://celoscan.io/tx/${h}`}>{h.slice(0, 14)}…</a></td>
                      <td>
                        {byTx.get(h)!.map((l, i) => (
                          <div key={i} style={{ fontSize: 13 }}>
                            {l.from.toLowerCase() === wallet.toLowerCase() ? "out" : "in"} {atomicToWhole(l.value, TOKENS[l.token].decimals)} {l.token}{" "}
                            <span className="hash">{l.from.toLowerCase() === wallet.toLowerCase() ? `→ ${l.to.slice(0, 10)}…` : `← ${l.from.slice(0, 10)}…`}</span>
                          </div>
                        ))}
                      </td>
                      <td>{tagged.get(h) ? <span className="chip ok">yes</span> : <span className="chip">no</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </>
    );
  } catch (e) {
    content = <div className="callout warn">Could not read Celo right now: {(e as Error).message}</div>;
  }
  return content;
}
