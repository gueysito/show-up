# Current state

Hosts can publish events with an optional funded USDC prize, and attendees can deposit
native USDC from NEAR with on-chain seat confirmation. Showup is building **V1**: publish, deposit across four chains,
check in, settle and award an optional USDC/Ethereum NFT prize. Scope and acceptance are in
[the plan](docs/plan.md#v1-work-packages); working rules are in [AGENTS.md](AGENTS.md).

## Already built (starting points for V1)

- App foundation: Next.js/TypeScript, PostgreSQL migrations, durable worker and CI.
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

Live cross-chain routing, mainnet check-in/settlement, NFT delivery and phone verification.

## Next action

V1-1 is complete: the reviewed 321,207-byte artifact is atomically deployed and
initialized at `showup-dev-14989f.near`. A real 1-USDC deposit/cancel/refund restores
the controller to 2.549953 USDC and leaves escrow at zero; [transaction evidence](docs/plan.md#v1-evidence).
The artifact retains its passing 53-test Rust/independent-replay CI evidence.
Current checks: 115 unit, 193 database and 46 browser cases; build/code checks pass.
The 3.73-wNEAR top-up was converted to native NEAR. Known allocation remains about
$27.20/$50; no further funding is requested. BasedHeads #2829 is selected, not moved.
V1-2 is complete: zero-prize publication and [funded USDC prize publication](https://nearblocks.io/txns/3HRPSdJqxRUEDjwWtGW53oXc6mam7jWyRvE7acVGg6s9)
work through the app. The 1-USDC prize was cancelled/refunded in full; accounting holds zero.
Checks used a preauthenticated engineering host and isolated project-wallet approval;
external wallet UI and a new provider login were not qualified by these checks.
V1-3 is complete: the browser confirms a real [1-USDC attendee deposit](https://nearblocks.io/txns/JCi8SuJpQ2eBUFoyrbXtQkwRJGdccJ2BCquH7gun1P4B)
and its full cancellation refund. Both RPCs confirm 2.549953 USDC restored and zero held.
V1-4 local Base/Ethereum payment adapters preserve signed quote terms and confirm
funding only from escrow. Live Base/Solana quotes return provider HTTP 400:
“Quoting for this pair is not available.” No cross-chain payment was sent.
V1-5/6 live-code check-in, closing and fixed-wallet receipts are locally implemented.
Next: verify their mainnet browser round trip while cross-chain pricing is blocked.
