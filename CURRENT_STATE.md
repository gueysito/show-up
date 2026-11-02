# Current state

Showup has a verified local application shell; event creation, login and payments are not yet available.

## Available

- Accepted PRD and two ADRs; one task tracker and existing standards/hooks.
- F1: pinned Node LTS/dependencies, blocked install scripts, release-age/integrity checks.
- Format, lint, typecheck, configuration unit test and production shell build pass.
- [Setup](docs/setup.md) records dependency and runtime limits.

## Next action

Implement F2–F4, then only I3 event-draft UI, validation and isolated development persistence.
The owner approved this bounded local implementation on November 2, 2026.
All work remains local and unpublished; other roadmap tasks need further approval.

## Not implemented or validated

Authentication, invitations, funding, contracts, attendance, rewards and hosted operations.
No complete host/attendee journey or production security validation is claimed.
Wallet ownership and Base/Solana/NEAR self-transfer checks passed; Ethereum execution/accounting passed,
with read-only finality still pending. No further signing is authorized or needed.
See [the plan](docs/plan.md) and [wallet evidence](docs/development-wallets.md).
