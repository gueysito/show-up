# Current state

You can prepare, validate, save and reopen fictional event drafts locally; login, publication and payments are unavailable.

## Available

- Accepted PRD and two ADRs; one task tracker and existing standards/hooks.
- F1–F4: pinned dependencies, Compose, checksummed migrations, transactional outbox and pg-boss.
- Bounded I3 draft UI: both modes, timings, budgets, quiz/NFT descriptors, rules preview and isolated persistence.
- Seven unit, twelve PostgreSQL and eight Chromium tests pass; actual Docker restart persistence verified.
- Owner-guided saving, validation, preview, conflict recovery and workspace-clear checks passed on November 2.
- [Review walkthrough](docs/verification.md), [setup](docs/setup.md), [isolation boundary](docs/adr/0003-local-draft-workspace.md).

## Next action

Review and approve the [recommended next bounded goal](docs/plan.md#recommended-next-bounded-goal-invite-only-host-workspace):
the five accepted UX fixes plus sign-in, host invitations and private event management.
The UX requirements are recorded in [PRD §18.1](docs/prd.md#181-host-draft-interactions); none is implemented yet.
The first goal is complete at `faa05ff`, with clean tracked-only reproduction verified.
Private GitHub branch publication is authorized; no merge or deployment is authorized.
The next build must pass agent browser testing before the owner receives a checklist of new behavior.

## Not implemented or validated

Authentication, invitations, funding, contracts, attendance, rewards and hosted operations.
No complete host/attendee journey or production security validation is claimed.
Wallet ownership and Base/Solana/NEAR self-transfer checks passed; Ethereum execution/accounting passed,
with read-only finality still pending. No further signing is authorized or needed.
See [the plan](docs/plan.md) and [wallet evidence](docs/development-wallets.md).
