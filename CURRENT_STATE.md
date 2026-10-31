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

Resolve withdrawal-fee collection, NFT custody across four networks, and draw
proof-failure recovery in [SCOPE-01](docs/plan.md), then finish provider/operational
choices and estimate an implementation plan. The [decision register](docs/technical-scope.md#decisions-needed-before-a-build-ready-plan)
identifies the remaining questions.

Next.js/Node.js, openid-client, PostgreSQL sessions, Docker Compose local setup,
and Railway hosting are accepted. The initial hosted product uses invitation-only
mainnet access with reduced testing deposits and bounded funds. No visitor-facing
simulation or separate testnet experience is planned; engineering tests still use
sandbox/testnets. Both attendance modes and NFT support on NEAR, Base, Solana,
and Ethereum are required. Product rules are recorded in the PRD; implementation,
spending, deployment, and public access remain unapproved.
