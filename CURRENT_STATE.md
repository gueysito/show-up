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

Review the documented authentication recommendation in [SCOPE-01](docs/plan.md)
before resuming hosting selection. Next.js + TypeScript on Node.js is accepted;
openid-client provider login plus application-owned sessions is proposed, not
implemented or live-tested. Base is the default EVM route; Ethereum remains required.
Both attendance modes and the daily streak model are confirmed. The proposed
build sequence has no implementation authorization yet.
