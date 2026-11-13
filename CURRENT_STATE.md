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

Owner phone checks passed for Google and Telegram sign-in, Android Phantom verification, and NEAR Mobile and Meteor message approval. The branded wallet picker and automatic save recovery pass isolated checks, including a lost response after a successful save.

The [phone deposit test](https://liable-pleat-maritime.ngrok-free.dev/events/af0f655d-eb25-483c-aca2-49b02a8d85b5/commit) verified a real [1-USDC deposit](https://nearblocks.io/txns/CB3pNnuxYbK7k7xjP9GBHRwT8iY7Xdb1ycNGkRntxtsT) from Android Chrome and NEAR Mobile and a [full refund](https://nearblocks.io/txns/6YzDCcH3vb7cKBtRkaiyntpg6hetBfAmDjTiqkq72ZCz) after cancellation. The phone showed both receipts. The pilot explains the Intents distinction when native USDC is short.

## Remaining

- V1-9: Rabby verification saved Base and Ethereum on Android Chrome and iPhone Safari. On iPhone, the attendee used the system Back to Safari link after signing on Base.
- [Railway web](https://web-production-f1245d.up.railway.app) runs `ad6f41a` with
  private Postgres. Home, health and account return HTTP 200. Both sign-in
  redirects use the hosted callbacks, and the owner completed Google and
  Telegram sign-in. The private worker is online and passed its signer and
  database checks. Hosted NEAR Mobile wallet verification persisted after refresh.
  The initial administrator grant succeeded and one-time setup closed.
  The owner redeemed a host invitation, and the protocol 88 worker processed the
  original [test publication](https://nearblocks.io/txns/2zExqmp6NJ92161dXLPsLzqhcrZhktDzPY3nt5ysFks1).
  The hosted [1-USDC deposit](https://nearblocks.io/txns/DcjkKiJdEuVazzZuHzXj9Yudr1AEZZoJFdTFown9ee1R)
  and [full refund](https://nearblocks.io/txns/HPiwMYCzMNqxTkqquZ3oTGfhkjyoRdWYyoAV6LcuxLLC)
  finalized on NEAR. V1-8 remains stretch.
- The owner confirmed the live paid refund receipt and wallet removal. The
  hosted Rabby phone check funded [1 USDC from Base](https://nearblocks.io/txns/9LdDsnWsQeJzjiYyyHDTBq9t7eZCa9E1eWjzzeANYbNu).
  Its [full refund](https://nearblocks.io/txns/6USn7CJ2Czx2owgort7QdNCwKDRzF1mkfkygmJkQKToj)
  finalized on NEAR. The hosted navigation, Rabby-only payment and receipt changes
  passed smoke checks. The reserve and wallet changes are live on web and worker.
- Next: publish a test event with an Ethereum NFT in custody, cancel it and
  verify the NFT returns to the contributor. The earlier mainnet check-in and
  settlement satisfy V1-5 and V1-6. A repeat funded Railway settlement is optional.
- After the NFT test, finish the visual polish and check the updated host controls
  and payout receipt in the browser. GitHub Actions billing blocked `verify` and
  `contracts`. Resolve billing and pass both checks on the release pull request.
  Merging requires owner approval.
