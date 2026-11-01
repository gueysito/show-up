# Current state

Users cannot yet create events, commit funds, or check in; Showup is in product scoping.

## Available

- Product requirements with journeys, accounting rules, technical gates, and acceptance criteria.
- A human and agent front door, one task tracker, and repository commit checks.
- [Technical scope](docs/technical-scope.md) with platform documentation and open decisions.

## Not implemented or validated

- Application, contracts, authentication, payments, Telegram bot, and host reports.
- Cross-chain funding and payout authorization, randomness proof, phone behavior,
  identity isolation, and deployment networks.
- Pilot outcomes, attendance lift, repeat use, and willingness to pay.

## Next action

Continue the [initial wallet test sequence](docs/plan.md#initial-wallet-test-sequence).
Read-only network/funding checks and Rabby EVM signing control passed; Solana/NEAR
signing control and small testnet transfer receipts remain untested.
[Wallet guide](docs/development-wallets.md) records funded
accounts, private-key storage boundary and isolated browser setup. Current work
covers wallet preparation and test planning; application implementation, automated
private-key signing, mainnet spending and deployment still need explicit approval.
The detailed build plan and both accepted ADRs remain the engineering baseline.

Next.js/Node.js, openid-client, PostgreSQL sessions, Docker Compose local setup,
and Railway hosting are accepted. The initial hosted product uses invitation-only
mainnet access with reduced testing deposits and bounded funds. No visitor-facing
simulation or separate testnet experience is planned; engineering tests still use
sandbox/testnets. Both attendance modes and NFT support on NEAR, Base, Solana,
and Ethereum are required. Product rules are recorded in the PRD; implementation,
spending, deployment, and public access remain unapproved.
