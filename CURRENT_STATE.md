# Current state

Showup is building **V1**: one complete loop on mainnet — publish an event, deposit from
NEAR, Solana, Base or Ethereum via NEAR Intents, check in, settle, and award a prize
(USDC pot and/or Ethereum NFT). The scope, order and acceptance are in
[the plan](docs/plan.md#v1-work-packages); working rules are in [AGENTS.md](AGENTS.md).

## Already built (starting points for V1)

- App foundation: Next.js/TypeScript, PostgreSQL migrations, durable worker, CI and
  pinned tooling.
- Google and Telegram sign-in with account linking; host event drafts with locked
  material terms.
- Escrow contract (Rust, `contracts/showup`): funding receipt, attendance, closing,
  draw, NFT custody, routed funding/returns and principal recovery modules, proven in
  the NEAR sandbox; a 5 test-USDC deposit and recovery round trip ran on NEAR testnet.
- Wallet control and event commitment review across NEAR, Solana, Base and Ethereum.
- NEAR Intents read-only quotes with verified quote signatures.
- Chain Signatures signing adapter for EVM transactions (local; not yet live).
- Attendance: host live codes, personal QR codes and staff scanning (local).
- Telegram bot, invitations, account export/deletion and recovery (V2; keep out of the
  V1 path).

## Not yet working

No Showup event journey has run on mainnet yet: no mainnet contract, no real cross-chain deposit, no
live Chain Signatures transfer, no real-phone check-in.

## Next action

[First-round funding](docs/development-wallets.md#mainnet-preparation-and-initial-funding)
is finalized on all four networks, including 2.549953 native NEAR USDC and verified
USDC storage registration. BasedHeads #2829 on Ethereum is selected; finalized
ERC-721/ownership reads match the external funding signer. No NFT transfer yet.
The corrected V1 build is 321,207 bytes. Full checks pass: 53 Rust tests including
nine V1 cases, independent replays, 99 app unit tests and production build. Both CI
jobs pass, including browser and app-to-contract checks. The [review corrections](docs/plan.md#v1-evidence)
cover deposit recovery, original-transaction NFT retries and self-only/atomic initialization.
Next: verify the **3.72 NEAR top-up to the controller**, deploy/initialize atomically,
then run a small deposit/refund. The former 3.66-NEAR quote is withdrawn.
No contract deployment or NFT transfer yet; known allocation remains about $12.09.
