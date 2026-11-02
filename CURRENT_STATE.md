# Current state

You can prepare, validate, save and reopen fictional event drafts locally; login, publication and payments are unavailable.

## Available

- Accepted PRD and two ADRs; one task tracker and existing standards/hooks.
- F1–F4: pinned dependencies, Compose, checksummed migrations, transactional outbox and pg-boss.
- Bounded I3 draft UI: both modes, timings, budgets, quiz/NFT descriptors, rules preview and isolated persistence.
- Seven unit, twelve PostgreSQL and eight Chromium tests pass; actual Docker restart persistence verified.
- [Review walkthrough](docs/verification.md), [setup](docs/setup.md), [isolation boundary](docs/adr/0003-local-draft-workspace.md).

## Next action

Owner testing at <http://127.0.0.1:3101/workbench>, following the review walkthrough.
The bounded goal is complete: clean tracked-only reproduction with an empty database passed.
The owner approved this bounded local implementation on November 2, 2026.
Implementation checkpoint: `faa05ff`. All work remains local and unpublished;
other roadmap tasks need further approval. No blocker remains within this scope.

## Not implemented or validated

Authentication, invitations, funding, contracts, attendance, rewards and hosted operations.
No complete host/attendee journey or production security validation is claimed.
Wallet ownership and Base/Solana/NEAR self-transfer checks passed; Ethereum execution/accounting passed,
with read-only finality still pending. No further signing is authorized or needed.
See [the plan](docs/plan.md) and [wallet evidence](docs/development-wallets.md).
