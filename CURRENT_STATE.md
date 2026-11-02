# Current state

You can prepare and reopen fictional drafts locally. Live sign-in is not configured;
private invitations and host management pass isolated-account checks. Funding and publication remain disabled.

## Available

- F1–F4: pinned runtime/Compose, migrations, durable outbox/worker and CI.
- Isolated anonymous draft workspace and UX-03–07 improvements.
- I1 code: signed OIDC verification, encrypted identity/linking, revocable HTTPS sessions and local admin bootstrap.
- I2: role-scoped invitations, explicit consent, atomic redemption and unused-link revocation/expiry.
- I3 private account drafts: save/reopen/edit/duplicate, ownership checks and locked material terms.
- 10 unit, 29 integration and 15 distinct Chromium scenarios covered; production/Docker builds pass.
- Private CI passed at `a1ea340`; newer checkpoint CI is verified after publication.
- [Verification](docs/verification.md), [secure setup](docs/setup.md#secure-local-identity-setup), [isolation](docs/adr/0003-local-draft-workspace.md).

## Next action

Continue [the active halfway goal](docs/plan.md#active-halfway-implementation-goal):
P1–P5 manifests/sandbox proofs, then I4–I5 commitments/recovery and A1–A4 attendance.
Google/Telegram registrations and callback proof remain owner/provider gates;
independent local work continues. Verified private-branch checkpoints are approved.
No merge, hosting, public signing/deployment, paid purchase or spending is authorized.

## Unimplemented or unverified

Live provider journeys, attributable funding, actual publication, contracts,
wallet commitments, principal return/reconciliation, privacy operations and attendance.
Published-state tests are fixtures. Rewards/claims/reporting/release stay in milestones 5–7.
No mainnet, real-phone or full halfway completion is claimed.
