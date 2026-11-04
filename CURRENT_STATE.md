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

Nothing has run on mainnet yet: no mainnet contract, no real cross-chain deposit, no
live Chain Signatures transfer, no real-phone check-in.

## Next action

Start [V1-1](docs/plan.md#v1-work-packages): build the V1 contract with money-path
tests, deploy it to a NEAR mainnet account within the
[V1 budget](docs/plan.md#mainnet-budget), and run one small real deposit and refund.
