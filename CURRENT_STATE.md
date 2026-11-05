# Current state

Showup V1 now publishes events, accepts native NEAR USDC deposits, checks attendees
in with a host live code, settles no-show shares and draws a funded USDC prize in
the real app on mainnet. Scope and next packages live in [the plan](docs/plan.md).
Working rules are in [AGENTS.md](AGENTS.md).

## Working on mainnet

- V1-1: reviewed 321,207-byte escrow deployed at `showup-dev-14989f.near`; the
  identical artifact retains its passing 53-test Rust/independent-replay evidence.
- V1-2/3: zero-prize and funded-prize publication; native USDC deposits and full
  cancellation refunds through the browser.
- V1-5: host live codes and a confirmed attendee/host roster; [check-in](https://nearblocks.io/txns/HJcPUxbvvigcCnQpNWtZ7X3SdApbVaDTEJvuFhYtm1wM).
- V1-6: two 1-USDC deposits and a 0.25-USDC prize [settled](https://nearblocks.io/txns/Hs7qvG1cBaS6bz3DRF3F5ahY9FeayFXipLRNB19YJwsZ)
  into a [2.25-USDC payout](https://nearblocks.io/txns/3DnWt7mZ31a3j2Q3RdVZ9JmZzADSsBLLUFGMiUmAY2pY).
  Mobile receipt shows principal + share + prize. Test USDC is restored in full.
- Both RPCs confirm 2.549953 USDC in the controller and zero held by escrow.
  Allocation remains about $27.20/$50; no additional funding is requested.

Checks use preauthenticated engineering accounts and isolated project-wallet
approval. External wallet UI, a fresh provider login and a real phone remain to verify.
116 unit, 193 database and 46 ordinary browser cases plus build/code checks pass.
GitHub CI cannot start jobs until the owner resolves its billing/spending limit.

## Remaining

- V1-4: Base/Ethereum route adapters are prepared locally. Live Base/Solana pricing
  returns HTTP 400 “Quoting for this pair is not available”; no routed funds sent.
  Connect the Solana transfer adapter while that external blocker remains.
- V1-7: BasedHeads #2829 is selected, not moved. Ethereum NFT custody/release and
  attendee Ethereum recipient binding still need app integration.
- V1-9: finish the front door/mobile polish and real-phone journey. Hosting and
  merging require owner approval. V1-8 source-chain returns remain stretch.
