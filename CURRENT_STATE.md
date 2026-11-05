# Current state

Hosts can publish zero-prize events from the app to NEAR mainnet and view verified
on-chain terms. Showup is building **V1**: publish, deposit across four chains,
check in, settle and award an optional USDC/Ethereum NFT prize. Scope and acceptance are in
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

Prize funding/publication, attendee deposits in the app, live cross-chain routing,
funded check-in/settlement, NFT delivery and real-phone check-in remain incomplete.

## Next action

V1-1 is complete: the reviewed 321,207-byte artifact is atomically deployed and
initialized at `showup-dev-14989f.near`. A real 1-USDC deposit/cancel/refund restores
the controller to 2.549953 USDC and leaves escrow at zero; [transaction evidence](docs/plan.md#v1-evidence).
The artifact retains its passing 53-test Rust/independent-replay CI evidence.
Current checks: 111 unit, 188 database and 45 browser cases; build and code checks pass.
The 3.73-wNEAR top-up was converted to native NEAR. Known allocation remains about
$27.20/$50; no further funding is requested. BasedHeads #2829 is selected, not moved.
V1-2's zero-prize browser path is verified on mainnet: [publication](https://nearblocks.io/txns/3Fn5FDSUu9vDXqor28yHGjKAH489D96h3wznJhUsxaca).
Desktop/mobile rechecks reuse the original receipt without signing again. Auth in
this check used a preauthenticated engineering fixture, not a new provider login.
Next: finish V1-2 prize funding/publication, then connect NEAR attendee deposits (V1-3).
