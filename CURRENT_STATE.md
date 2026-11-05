# Current state

Showup V1 now publishes events, accepts deposits from NEAR, Base, Solana and Ethereum, checks attendees
in with a host live code, settles no-show shares and draws a funded USDC prize in
the real app on mainnet. Scope and next packages live in [the plan](docs/plan.md).
Working rules are in [AGENTS.md](AGENTS.md).

## Working on mainnet

- V1-1: reviewed 321,207-byte escrow deployed at `showup-dev-14989f.near`; the
  identical artifact retains its passing 53-test Rust/independent-replay evidence.
- V1-2/3: zero-prize and funded-prize publication; native USDC deposits and full
  cancellation refunds through the browser.
- V1-4: Base, Solana and Ethereum each routed 1 USDC through an isolated Intents
  balance into escrow, showed the funded mobile receipt and received a full NEAR
  cancellation refund. [Transactions](docs/plan.md#v1-evidence). No extra contract deployed.
- V1-5: host live codes and a confirmed attendee/host roster; [check-in](https://nearblocks.io/txns/HJcPUxbvvigcCnQpNWtZ7X3SdApbVaDTEJvuFhYtm1wM).
- V1-6: two 1-USDC deposits and a 0.25-USDC prize [settled](https://nearblocks.io/txns/Hs7qvG1cBaS6bz3DRF3F5ahY9FeayFXipLRNB19YJwsZ)
  into a [2.25-USDC payout](https://nearblocks.io/txns/3DnWt7mZ31a3j2Q3RdVZ9JmZzADSsBLLUFGMiUmAY2pY).
  Mobile receipt shows principal + share + prize. Test USDC is restored in full.
- Both RPCs confirm 5.549953 USDC in the controller and zero held by escrow or the
  three receiving Intents balances; cumulative receipts/payments are 11.25 USDC each.
  Allocation remains about $27.20/$50; no additional funding is requested.

Checks use preauthenticated engineering accounts and isolated project-wallet
approval. External wallet UI, a fresh provider login and a real phone remain to verify.
128 unit, 195 database and 48 ordinary browser cases plus build/code checks pass.
GitHub CI cannot start jobs until the owner resolves its billing/spending limit.
The local owner database is backed up and updated through all 39 migrations;
there are no pending native transaction queues.

## Remaining

- V1-7: NFT custody/publication, attendee Ethereum binding, cancellation and signed
  delivery are implemented locally. Both mainnet RPCs verify the MPC key format;
  synthetic browser/DB cases pass. BasedHeads #2829 still needs its owner's wallet
  transfer and a real mainnet custody/release round trip.
- V1-9: front door and V1 preview run locally; desktop/390/320 layouts and real
  host navigation pass. A clean clone installs/builds on pinned Node 24 and serves
  home/preview/database health with HTTP 200. The real-phone journey remains.
  Hosting and merging require owner approval. V1-8 source-chain returns remain stretch.
