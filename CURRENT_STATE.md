# Current state

Showup V1 now publishes events, accepts deposits from NEAR, Base, Solana and Ethereum, checks attendees
in with a host live code, settles no-show shares and draws a funded USDC prize in
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
- The NFT test event is [published](https://nearblocks.io/txns/3sG2pnLF9vtNxM1hRn4aqTpxanem9XpwCeTH5EyiAJYb)
  and its attendee [deposited 1 USDC](https://nearblocks.io/txns/GieCsPRzt9igQip2AnD8GjTdRFYL9LsUzvnHUouHS29j)
  with a locked Ethereum recipient. Controller USDC is 0.366697, escrow holds 1,
  and the controller owns 0.038156 USDC in Intents. Allocation remains below $50;
  no additional owner funding is requested.

Checks use preauthenticated engineering accounts and isolated project-wallet
approval. External wallet UI, a fresh provider login and a real phone remain to verify.
The existing app baseline passes 195 database and 48 ordinary browser cases;
the network-fee correction passes 131 unit and six isolated database cases.
GitHub CI cannot start jobs until the owner resolves its billing/spending limit.
The local owner database is backed up and updated through all 39 migrations;
there are no pending native transaction queues.

## Remaining

- V1-7: NFT custody/publication, attendee Ethereum binding, cancellation and signed
  delivery are implemented locally. The test event's Ethereum custody address is
  now derived and verified: `0x098a2830a7C2Bb6eC97d003361F3090CE3ba2CE0`.
  BasedHeads #2829's owner transfer, publication and attendee funding are verified.
  The 0.002-ETH ceiling is deployed; receipt validation uses the exact signed fee
  envelope. Check-in/settlement open at 16:33 UTC today, then the real signed NFT
  release remains. No onward NFT transfer has occurred.
- V1-9: front door and V1 preview run locally; desktop/390/320 layouts and real
  host navigation pass. A clean clone installs/builds on pinned Node 24 and serves
  home/preview/database health with HTTP 200. The real-phone journey remains.
  Hosting and merging require owner approval. V1-8 source-chain returns remain stretch.

The owner-local app runs at `https://localhost:3443`. The existing approved
[development pilot](https://liable-pleat-maritime.ngrok-free.dev/account) now serves
the rebuilt production app from `c755607`: home/account/health return HTTP 200;
anonymous NFT requests return 401 and foreign-origin mutations return 403.
Phone access depends on the development computer and its existing tunnel staying
running. Fresh phone sign-in, external-wallet approval and NFT release remain to verify.
