# HaxenMed Restock Agent

An agent that keeps a pharmacy stocked and pays its suppliers in their own currency on Celo, from a wallet the pharmacy owner controls.

Built for **Agents Open for Business** (Celo × Loops House, Nov–Dec 2026). Tracks: **Stablecoin Corridors (Textile FX)** and **Altana Smart Agentic Wallets**.

## The job it does

> TODO before submission: name the pilot pharmacy and its supplier, and say in one or two sentences how they pay each other today (method, days to clear, cost). Judges score "a named user with a real job done".

When a pharmacy runs low on paracetamol or ORS while a cross-border supplier payment clears, patients are turned away. This agent closes that gap. It notices the shortfall, pays the supplier in their own currency the same day, and keeps a record the owner can check.

The agent:

1. **Reads stock levels** from HaxenMed, the pharmacy's management system, through one narrow, key-protected endpoint. It gets only stock counts, sales rate, supplier and unit price.
2. **Plans the reorder**: anything at or below its reorder point gets enough whole cartons to cover lead time plus two weeks.
3. **Converts USD₮ to naira (cNGN)** on Textile FX for exactly the amount the supplier is owed.
4. **Pays the supplier in cNGN** on Celo, from the pharmacy's Altana wallet, inside the limits the owner set.
5. **Reconciles**: it checks its own books against the chain and reports anything that doesn't match.

## Who controls the money

The pharmacy owner does, at all times, and the chain enforces it.

- The wallet is a **non-custodial Altana smart agentic wallet**. The owner's key controls it; Altana never holds keys.
- The agent only holds a **session key** the owner granted. The key can only:
  - approve USD₮ for Textile and call Textile's settlement contract
  - transfer cNGN or USD₮
  - spend up to a **daily cap** per token, which also covers network fees
  - act until an **expiry**
- **Revoking** the key is one transaction (`owner:revoke`). After that, the chain refuses every call the agent makes.
- On top of the onchain cap, the agent applies its own **per-order and per-run limits** and stops before quoting anything larger.

## How it handles money safely

The payment code is built the way a payments backend should be, not like a script:

- **Double-entry ledger.** Every movement is a journal entry whose postings sum to zero per currency. Amounts are integers in token units, never floats. Postings can't be edited or deleted (database triggers); mistakes are fixed with a correcting entry.
- **Idempotent payments.** The purchase order id is the idempotency key. Running the agent twice, or retrying after a crash, can never pay the same order twice. The same order id with different details is refused.
- **An explicit state machine.** Each payment moves `CREATED → QUOTED → SWAP_SUBMITTING → SWAPPED → PAY_SUBMITTING → PAID → RECONCILED`, or to `BLOCKED` / `FAILED`. Every move is a compare-and-set on state and version, written together with its ledger entry and an append-only audit event.
- **Crash recovery that asks, not guesses.** Before each onchain step, the intent is saved. If the agent dies mid-step, the next run asks Textile whether the swap filled, and searches the chain for the supplier transfer. It waits for confirmations before deciding a transfer never happened, so a slow transaction can't cause a double payment.
- **Reconciliation.** `reconcile` reads every USD₮ and cNGN transfer in and out of the wallet. It books owner deposits and relay fees, matches swaps and payments, and checks every payment carries our attribution tag. Then it compares the ledger's balance with the chain's. Money that left the wallet in a transaction the agent didn't send is booked to a suspense account and flagged as an error.

The tests in `test/` cover each of these against simulated Textile, wallet and chain. They include a crash right after the swap is sent, a crash right after the supplier transfer is sent, a transfer that never lands, the owner's cap stopping a payment mid-way, and an unexplained outflow being caught.

## Status

Built and tested against simulated services. Not yet run on Celo mainnet: the first live payment, wallet address, ERC-8004 agent id and transaction links will be added here when they exist.

## Onchain details

| What | Where |
|---|---|
| Chain | Celo mainnet (42220) |
| Conversion | Textile FX RFQ v2, USD₮ → cNGN, firm quotes, keyless (wallet proof of control) |
| Wallet | Altana smart agentic wallet (EIP-7702), session key with spend caps, allowlist, expiry |
| Identity | ERC-8004, registered by the Altana SDK after the wallet's first owner action |
| Attribution | ERC-8021 tag on every transaction, our code set via the Altana SDK's `appCode` |

## Running it

Needs Node 22.18+ (24 recommended). TypeScript runs directly on Node, with no build step.

```sh
npm install
node scripts/install-hooks.ts            # blocks commits that contain keys
npm test                                 # ledger, payment flow, reconciliation
npm run agent -- plan                    # what would be ordered today (sends nothing)
```

Going live on mainnet uses real money. Use small amounts.

```sh
cp .env.example .env                     # then add OWNER_PRIVATE_KEY (never commit .env)
npm run agent -- owner:grant --usdt-per-day 30 --cngn-per-day 40000 --days 14
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
src/fx/textile.ts           Textile FX RFQ client
src/wallet/altana.ts        session-key wallet, permissions, chain reads
src/wallet/owner.ts         owner actions: grant, revoke, proof of control
src/planner.ts              reorder planning
src/inventory/source.ts     stock source (HaxenMed endpoint or a file)
```

## License

All rights reserved. The source is public for judging; it is not open source.
