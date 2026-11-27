# HaxenMed Restock Agent

An agent that keeps a pharmacy in Ghana stocked and pays its suppliers in cedis on Celo, from a wallet the pharmacy owner controls.

Built for **Agents Open for Business** (Celo × Loops House, Nov–Dec 2026), track: **Altana Smart Agentic Wallets**.

## The job it does

> TODO before submission: name the pilot pharmacy and its supplier, and say in one or two sentences how they pay each other today (method, days to clear, cost). Judges score "a named user with a real job done".

When a pharmacy runs low on paracetamol or ORS and the reorder waits on a supplier payment, patients are turned away. This agent closes that gap: it notices the shortfall, pays the supplier in cedis the same day, and keeps a record the owner can check.

The agent:

1. **Reads stock levels**: stock on hand, sales rate, supplier and unit price, from a stock file today. It is built for HaxenMed, the pharmacy system we run for pharmacies in Ghana. A key-protected HaxenMed endpoint client is included; the endpoint itself is not yet live.
2. **Plans the reorder**: anything at or below its reorder point gets enough whole cartons to cover lead time plus two weeks.
3. **Converts USD₮ to Ghana cedis (GHSm)** on Mento, Celo's stablecoin exchange. It swaps just enough that even the worst price it allows still covers the invoice.
4. **Pays the supplier in GHSm** on Celo, from the pharmacy's Altana wallet, inside the limits the owner set.
5. **Reconciles**: it checks its own books against the chain and reports anything that doesn't match.

GHSm is the Mento Ghanaian Cedi (formerly cGHS), at `0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313`. Mento routes USD₮ → USDm → GHSm through its Router (`0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6`).

## Who controls the money

The pharmacy owner does, at all times, and the chain enforces it.

- The wallet is a **non-custodial Altana smart agentic wallet**. The owner's key controls it; Altana never holds keys.
- The agent only holds a **session key** the owner granted. The key can only:
  - approve USD₮ and call Mento's Router
  - transfer GHSm or USD₮
  - spend up to a **daily cap** per token, which also covers network fees
  - act until an **expiry**
- **Revoking** the key is one transaction (`owner:revoke`). After that, the chain refuses every call the agent makes.
- On top of the onchain cap, the agent applies its own **per-order and per-run limits** and stops before it quotes anything larger.

## How it handles money safely

The payment code is built the way a payments backend should be, not like a script:

- **Double-entry ledger.** Every movement is a journal entry whose postings sum to zero per currency. Amounts are integers in token units, never floats. Postings can't be edited or deleted (database triggers); mistakes are fixed with a correcting entry.
- **Idempotent payments.** The purchase order id is the idempotency key. Running the agent twice, or retrying after a crash, can never pay the same order twice. The same order id with different details is refused.
- **An explicit state machine.** Each payment moves `CREATED → QUOTED → SWAP_SUBMITTING → SWAPPED → PAY_SUBMITTING → PAID → RECONCILED`, or to `BLOCKED` / `FAILED`. Every move is a compare-and-set on state and version, written together with its ledger entry and an append-only audit event.
- **Crash recovery that checks, not guesses.** Before each onchain step, the intent is saved. If the agent dies mid-step, the next run searches the chain for the swap and the supplier transfer. A cedi deposit is only accepted as the swap if the same transaction also spent the swap's exact USD₮, so an owner's top-up can't be mistaken for it. It waits for confirmations before deciding anything never happened, so a slow transaction can't cause a double payment.
- **Reconciliation.** `reconcile` reads every USD₮ and GHSm transfer in and out of the wallet. It books owner deposits and relay fees, matches swaps and payments, and checks every payment carries our attribution tag. Then it compares the ledger's balance with the chain's. Money that left the wallet in a transaction the agent didn't send is booked to a suspense account and flagged as an error.

The tests in `test/` cover each of these against a simulated Mento, wallet and chain. They include a crash right after the swap, a crash right after the supplier payment, a swap and a payment that never land, an owner's top-up arriving after a lost swap, the owner's cap stopping a payment mid-way, a revoked session, and an unexplained outflow being caught.

## Onchain details

| What | Where |
|---|---|
| Chain | Celo mainnet (42220) |
| Conversion | Mento Router, USD₮ → USDm → GHSm, exact-input swap sized so the minimum output covers the invoice |
| Wallet | Altana smart agentic wallet (EIP-7702), session key with spend caps, allowlist, expiry |
| Identity | ERC-8004, registered by the Altana SDK after the wallet's first owner action |
| Attribution | ERC-8021 tag on every transaction, our code set via the Altana SDK's `appCode` |

The code also includes a Textile FX rail for suppliers paid in naira (cNGN). It is off unless the owner grants a cNGN cap, and our pilot doesn't use it.

### Addresses: ours vs. the contracts we call

| | Address | Whose |
|---|---|---|
| Agent wallet (Altana, EIP-7702) | `0xa97a7C6c3ec143986E739805b5875a1FB0a97909` | **Ours.** Not yet funded; it has no transactions until the first mainnet run |
| Mento Router | `0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6` | Mento's, shared. Its transaction history is not ours |
| GHSm (Mento Ghanaian Cedi) | `0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313` | Mento's token |
| USD₮ | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | Tether's token |
| ERC-8004 Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Shared registry |

## Live demo, for people and for agents

The web app is at **https://haxen-restock-agent.vercel.app**. Its "Try a restock" page runs this repo's real planner, ledger, payment code and reconciler against a simulated Mento, wallet and chain, priced at Mento's live cedi rate. No real money moves.

Agents and automated reviewers can call it directly. No key is needed; plain HTTP clients work:

```sh
# What the service is, what's live, and the endpoints
curl https://haxen-restock-agent.vercel.app/api/health

# The live Mento cedi rate and the failure scenarios you can run
curl https://haxen-restock-agent.vercel.app/api/demo

# Run a simulated restock; scenario is one of: normal, crash_after_swap,
# crash_after_transfer, transfer_lost, cap_hit, revoked
curl -X POST https://haxen-restock-agent.vercel.app/api/demo \
  -H 'content-type: application/json' -d '{"scenario":"crash_after_swap"}'
```

The site is on Vercel. If an automated request ever gets HTTP 403, that is most likely Vercel's own screening of unfamiliar automated traffic, not this app: the app has no login, key or user-agent check. The same demo runs locally with `npm install && npm run dev`, then `http://localhost:3000/demo`.

## Running it

Needs Node 22.18+ (24 recommended). TypeScript runs directly on Node, with no build step.

```sh
npm install
node scripts/install-hooks.ts            # blocks commits that contain keys
npm test                                 # ledger, payment flow, Mento rail, reconciliation, demo
npm run agent -- plan                    # what would be ordered today (sends nothing)
npm run dev                              # the web app: overview, simulated demo, live page
```

Going live on mainnet uses real money. Use small amounts.

```sh
cp .env.example .env                     # then add OWNER_PRIVATE_KEY (never commit .env)
npm run agent -- owner:grant --usdt-per-day 30 --ghs-per-day 300 --days 14
npm run agent -- run                     # dry run: shows orders, stops before paying
npm run agent -- run --yes --inventory path/to/real-suppliers.json
npm run agent -- status
npm run agent -- reconcile --from-block <block the wallet was funded>
npm run agent -- owner:revoke            # stop the agent in one transaction
```

The bundled `data/sample-inventory.json` is demo data with a burn address as the supplier. The agent refuses to pay it.

## Layout

```
src/ledger/ledger.ts        double-entry ledger, payment state machine, audit trail
src/payments/executor.ts    the payment flow with crash recovery and limits
src/payments/reconcile.ts   ledger vs chain
src/fx/rail.ts              what any FX rail must guarantee
src/fx/mento.ts             Mento rail: USD₮ -> GHSm (cedis)
src/fx/textile-rail.ts      Textile rail: USD₮ -> cNGN (naira), off by default
src/wallet/altana.ts        session-key wallet, permissions, chain reads
src/wallet/owner.ts         owner actions: grant, revoke
src/planner.ts              reorder planning
src/sim/                    simulated Mento, Textile, wallet and chain, and the web demo
app/                        Next.js web app
```

## Status

Built and tested against simulated services (40 tests). The Mento sizing was checked read-only against mainnet: paying GH₵368 needs 31.53 USD₮, with a guaranteed minimum of exactly GH₵368.00. Not yet run on Celo mainnet: the first live payment, wallet address, ERC-8004 agent id and transaction links will be added here when they exist.

## License

All rights reserved. The source is public for judging; it is not open source.
