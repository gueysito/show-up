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

The V1 escrow is live on mainnet with a verified manual 1-USDC deposit/cancel/refund.
The app-to-mainnet event journey, cross-chain deposits, live Chain Signatures NFT
transfer and real-phone check-in are not working yet.

## Next action

V1-1 is complete: the reviewed 321,207-byte artifact is atomically deployed and
initialized at `showup-dev-14989f.near`. A real 1-USDC deposit/cancel/refund restores
the controller to 2.549953 USDC and leaves escrow at zero; [transaction evidence](docs/plan.md#v1-evidence).
The artifact retains its passing 53-test Rust/independent-replay CI evidence;
109 current app/operator unit tests, format/lint/types and production build pass.
The 3.73-wNEAR top-up was converted to native NEAR. Known allocation remains about
$27.20/$50; no further funding is requested. BasedHeads #2829 is selected, not moved.
V1-2 publication wiring and local browser checks pass: host requests lock terms;
a separate signer submits one retained transaction; the event page checks mainnet.
Next: verify that browser journey with one real zero-prize mainnet publication.
