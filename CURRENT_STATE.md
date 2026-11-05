# Current state

Showup V1 now publishes events, accepts deposits from NEAR, Base, Solana and Ethereum, checks attendees
in with a host live code, settles no-show shares and delivers USDC and Ethereum NFT prizes in
the real app on mainnet. Scope and next packages live in [the plan](docs/plan.md).
Working rules are in [AGENTS.md](AGENTS.md).

## Working on mainnet

- V1-1: the same escrow account [upgraded](https://nearblocks.io/txns/3YFQdrpz9f5yr89Fq4yhHEVpmwYZoiegSWwZ4astjFt8)
  without changing NFT state/accounting; its new [1-USDC deposit](https://nearblocks.io/txns/61G14BvWNdgLoM9sCRamSQgcHWYiZYJX2X7ukFkX3dSK)
  and [full refund](https://nearblocks.io/txns/DWbiuuU8p5FCHkDPc1BcXTYk6qmJqLDCJHbkPJfGX9Ax) succeeded.
- V1-2/3: zero-prize and funded-prize publication; native USDC deposits and full
  cancellation refunds through the browser.
- V1-4: Base, Solana and Ethereum each routed 1 USDC through an isolated Intents
  balance into escrow, showed the funded mobile receipt and received a full NEAR
  cancellation refund. [Transactions](docs/plan.md#v1-evidence). No extra contract deployed.
- V1-5: host live codes and a confirmed attendee/host roster; [check-in](https://nearblocks.io/txns/HJcPUxbvvigcCnQpNWtZ7X3SdApbVaDTEJvuFhYtm1wM).
- V1-6: two 1-USDC deposits and a 0.25-USDC prize [settled](https://nearblocks.io/txns/Hs7qvG1cBaS6bz3DRF3F5ahY9FeayFXipLRNB19YJwsZ)
  into a [2.25-USDC payout](https://nearblocks.io/txns/3DnWt7mZ31a3j2Q3RdVZ9JmZzADSsBLLUFGMiUmAY2pY).
  Mobile receipt shows principal + share + prize. Test USDC is restored in full.
- V1-7: BasedHeads #2829 went from derived custody to its locked winner's Ethereum
  wallet. The app shows the [finalized delivery](https://etherscan.io/tx/0xbb8e8c5527abf7a94e01385c128457fc33b138be6fe15f90b1f75b2ba271475f)
  and the attendee's [full 1-USDC refund](https://nearblocks.io/txns/3H2BErLf6XE8mBJoyRrFiVtU3LBfHqC1wv7onbb4g4vL).
  The [test NFT return](https://etherscan.io/tx/0xbd125a3c4546551197e568b8daec1ca4da7eb0d997163904d574700cfc9843a3)
  finalized back to the original sending wallet. Cancellation is covered by sandbox tests.
- Both NEAR RPCs confirm 1.366697 USDC in the controller, 0.038156 in its Intents
  balance and zero held by escrow. Cumulative receipts and payouts are 14.25 USDC
  each. Allocation remains below $50; no additional owner funding is requested.

Mainnet transaction checks used preauthenticated engineering accounts and isolated
project-wallet approval. The owner completed Google sign-in on a real phone.
Telegram sign-in worked inside Phantom. On Android, the app-opening link reached
Showup, Solana message approval saved a verified wallet, and the wallet stayed
saved after refresh.
The existing app baseline passes 195 database and 48 ordinary browser cases;
the network-fee correction passes 131 unit and six isolated database cases.
GitHub CI cannot start jobs until the owner resolves its billing/spending limit.
The local owner database is backed up and updated through all 39 migrations;
there are no pending native transaction queues.

## Remaining

- V1-9: front door and V1 preview run locally; desktop/390/320 layouts and real
  host navigation pass. A clean clone installs/builds on pinned Node 24 and serves
  home/preview/database health with HTTP 200. Both provider sign-in screens open
  through the pilot in a fresh iPhone-sized browser. Owner phone sign-in and
  Android Phantom verification passed. iPhone Safari app-link testing, real
  Meteor approval and a phone payment remain.
  Hosting and merging require owner approval. V1-8 source-chain returns remain stretch.

The owner-local app runs at `https://localhost:3443`. The existing approved
[development pilot](https://liable-pleat-maritime.ngrok-free.dev/account) serves
the rebuilt production app from `a51b339`. Wallets and health return HTTP 200.
Unauthenticated wallet requests return 401, and foreign-origin wallet mutations
return 403.
Phone access depends on the development computer and its existing tunnel staying
running. A new browser may show ngrok's one-time **Visit Site** screen.

The live MyNearWallet `/sign-message` and `/sign` screens now reject app requests
following its [retirement](https://www.mynearwallet.com/sunset). The earlier
engineering runs bypassed those screens. A real phone approved a NEAR Mobile
message, Showup stored the verified proof and the wallet survived refresh. The
Meteor option passes isolated browser checks. The app prepares native deposit,
storage and prize approvals for both wallets and checks the original request
before creating another. The live phone payment/refund remains. The wallet page
has opening links for Phantom, MetaMask and Rabby.

The [phone deposit test](https://liable-pleat-maritime.ngrok-free.dev/events/af0f655d-eb25-483c-aca2-49b02a8d85b5)
is published on mainnet with one seat, a 1-USDC deposit and no prize. The next
action is the real phone deposit, followed by cancellation and refund.
