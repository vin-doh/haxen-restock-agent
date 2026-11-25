# First live run on Celo mainnet (minimum budget)

Budget: about 35 CELO (Altana key registrations) and 6 USD₮ (one small order plus fees). Every step below that moves money or writes onchain is run only after the owner says yes.

| # | Step | Command | Onchain? | Costs (approx.) |
|---|---|---|---|---|
| 0 | Owner funds the wallet (CELO and USD₮ on the **Celo** network) | (owner, from an exchange or wallet) | yes | 35 CELO, 6 USD₮ |
| 1 | Check what arrived | `npm run agent -- wallet` | read-only | free |
| 2 | Grant the agent its session key: USD₮ 6/day, GHSm 60/day, 14 days, allowlist of approve / Mento Router / transfers. Also registers the ERC-8004 identity | `npm run agent -- owner:grant --usdt-per-day 6 --ghs-per-day 60 --days 14` | yes | ~20 CELO registration (10% margin refunded) |
| 3 | Add the wallet address in the Loops House playground ("Add wallet") | (browser) | no | free |
| 4 | Preview the real order | `npm run agent -- run --inventory state/pilot-order.json` | no (dry run) | free |
| 5 | Pay it: Mento swap USD₮ → GHSm, then GHSm to the supplier | `npm run agent -- run --yes --inventory state/pilot-order.json` | yes | order (~₵35–50, about 3–4.3 USD₮) plus relay fees in USD₮ |
| 6 | Reconcile the ledger against the chain | `npm run agent -- reconcile --from-block <funding block>` | read-only | free |
| 7 | Show the cap: an order above the session's daily USD₮ cap is refused | raise `MAX_USDT_PER_ORDER` above 6 in `.env`, run `run --yes` with a bigger order | refused before sending | free |
| 8 | Revoke the session key: the Altana track needs a revoke transaction | `npm run agent -- owner:revoke` | yes | small fee |
| 9 | Show the agent stopped: `run --yes` is refused onchain | `npm run agent -- run --yes --inventory …` | refused | free |
| 10 | Re-grant, so the agent can keep working | `npm run agent -- owner:grant …` (as in step 2) | yes | ~10 CELO registration |

After step 5, set these on Vercel so the Live page shows real activity: `AGENT_WALLET`, `ERC8004_AGENT_ID`, `START_BLOCK`.

The real order file lives in `state/pilot-order.json`, which Git ignores. `data/pilot-order.example.json` shows its shape. The supplier's `payoutAddress` must be the supplier's own Celo wallet. The agent refuses zero and burn addresses.
