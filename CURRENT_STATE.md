# Current state

Showup V1 publishes mainnet events, accepts deposits from NEAR, Base, Solana and Ethereum, checks attendees in with a host live code, and pays refunds, no-show shares, USDC prizes and Ethereum NFTs. The [plan](docs/plan.md) tracks scope, receipts and next steps. [AGENTS.md](AGENTS.md) has working rules.

## Working on mainnet

- V1-1: the existing escrow account [upgraded](https://nearblocks.io/txns/3YFQdrpz9f5yr89Fq4yhHEVpmwYZoiegSWwZ4astjFt8) without changing NFT state or accounting. Its next [1-USDC deposit](https://nearblocks.io/txns/61G14BvWNdgLoM9sCRamSQgcHWYiZYJX2X7ukFkX3dSK) and [refund](https://nearblocks.io/txns/DWbiuuU8p5FCHkDPc1BcXTYk6qmJqLDCJHbkPJfGX9Ax) succeeded.
- V1-2/3: zero-prize and funded-prize publication, native USDC deposits and full cancellation refunds through the browser.
- V1-4: Base, Solana and Ethereum each routed 1 USDC through Intents to escrow, showed a funded receipt and received a full NEAR cancellation refund. [Transactions](docs/plan.md#v1-evidence)
- V1-5: host live code and confirmed attendee roster. [Check-in](https://nearblocks.io/txns/HJcPUxbvvigcCnQpNWtZ7X3SdApbVaDTEJvuFhYtm1wM)
- V1-6: two 1-USDC deposits and a 0.25-USDC prize settled into a [2.25-USDC payout](https://nearblocks.io/txns/3DnWt7mZ31a3j2Q3RdVZ9JmZzADSsBLLUFGMiUmAY2pY).
- V1-7: BasedHeads #2829 went to the locked winner's wallet, the attendee received a [full 1-USDC refund](https://nearblocks.io/txns/3H2BErLf6XE8mBJoyRrFiVtU3LBfHqC1wv7onbb4g4vL), and the [test NFT returned](https://etherscan.io/tx/0xbd125a3c4546551197e568b8daec1ca4da7eb0d997163904d574700cfc9843a3) to the original sender. Cancellation is covered in sandbox.
- After the engineering runs, both NEAR RPCs showed zero USDC in escrow, cumulative receipts and payouts of 14.25 USDC each, and 1.404853 USDC across the controller and its Intents balance. Allocation remains below $50.

## Phone pilot

The owner-local app runs at `https://localhost:3443`. The existing [development pilot](https://liable-pleat-maritime.ngrok-free.dev/account) serves the updated wallet build and requires the development computer and tunnel to stay running. Health, wallets and the test commitment page return HTTP 200. Anonymous and foreign-origin commitment requests return 401 and 403 respectively. The pilot database was backed up and migrated through 040.

Owner phone checks passed for Google and Telegram sign-in, Android Phantom verification, and NEAR Mobile message approval. Verified wallets persisted after refresh. The wallet page includes Phantom, MetaMask and Rabby opening links. NEAR Mobile and Meteor replace the retired MyNearWallet approval screens.

The [phone deposit test](https://liable-pleat-maritime.ngrok-free.dev/events/af0f655d-eb25-483c-aca2-49b02a8d85b5/commit) has one registered 1-USDC seat and no prize. The attendee moved USDC from NEAR Intents to NEAR, and the live payment preflight passed. Showup explains the Intents distinction when native USDC is short. A funded seat shows a green confirmation and a blue explorer link once the exact deposit transaction is verified. Finish phone approval, then cancel and refund.

## Remaining

- V1-9: finish the real phone payment, Meteor approval and Safari app-link checks. The home, preview and host navigation pass local phone/desktop layout checks, and the clean-clone build is verified.
- Permanent hosting and merging require owner approval. V1-8 source-chain returns remain stretch.
- GitHub CI requires account billing attention. Continue using local checks.
