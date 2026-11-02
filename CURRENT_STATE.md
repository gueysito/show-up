# Current state

Showup runs locally with PostgreSQL and a recoverable worker; event creation, login and payments are not yet available.

## Available

- Accepted PRD and two ADRs; one task tracker and existing standards/hooks.
- F1–F4: pinned dependencies, Compose, checksummed migrations, transactional outbox and pg-boss.
- Format, lint, types, unit/integration, Chromium smoke and production/container builds pass.
- [Setup](docs/setup.md) records dependency and runtime limits.

## Next action

Implement only I3 event-draft UI, validation and isolated development persistence.
The owner approved this bounded local implementation on November 2, 2026.
All work remains local and unpublished; other roadmap tasks need further approval.

## Not implemented or validated

Authentication, invitations, funding, contracts, attendance, rewards and hosted operations.
No complete host/attendee journey or production security validation is claimed.
Wallet ownership and Base/Solana/NEAR self-transfer checks passed; Ethereum execution/accounting passed,
with read-only finality still pending. No further signing is authorized or needed.
See [the plan](docs/plan.md) and [wallet evidence](docs/development-wallets.md).
