# Current state

You can prepare, validate, save and reopen fictional event drafts locally; login, publication and payments are unavailable.

## Available

- Accepted PRD and three ADRs; one task tracker and existing standards/hooks.
- F1–F4: pinned dependencies, Compose, checksummed migrations, transactional outbox and pg-boss.
- Bounded I3 draft UI: both modes, timings, budgets, quiz/NFT descriptors, rules preview and isolated persistence.
- Seven unit, twelve PostgreSQL and eleven Chromium tests pass; actual Docker restart persistence verified.
- UX-03–07: timezone suggestions, visible save/errors, explicit conflict recovery and separate answer choices.
- Owner-guided saving, validation, preview, conflict recovery and workspace-clear checks passed on November 2.
- [Review walkthrough](docs/verification.md), [setup](docs/setup.md), [isolation boundary](docs/adr/0003-local-draft-workspace.md).

## Next action

Implement the authorized [halfway goal](docs/plan.md#active-halfway-implementation-goal):
UX-03–07, P1–P5, I1–I5 and A1–A4 through milestone 4. Begin with external-provider
preflight and I1/I2 identity/access. UX-03–07 now pass local checks; the larger goal remains incomplete.
The first goal is complete at `faa05ff`, with clean tracked-only reproduction verified.
Verified private-branch checkpoints are authorized; no merge, public deployment,
public-network signing or spending is authorized by this goal.
The next build must pass agent browser testing before the owner receives a checklist of new behavior.

## Not implemented or validated

Authentication, invitations, funding, contracts, attendance, rewards and hosted operations.
No complete host/attendee journey or production security validation is claimed.
Wallet ownership and Base/Solana/NEAR self-transfer checks passed; Ethereum execution/accounting passed,
with read-only finality still pending. No further signing is authorized or needed.
See [the plan](docs/plan.md) and [wallet evidence](docs/development-wallets.md).
