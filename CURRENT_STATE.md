# Current state

You can prepare and reopen fictional drafts locally. Live sign-in is not configured;
private invitations and host management pass isolated-account checks. Funding and publication remain disabled.

## Available

- F1–F4: pinned runtime/Compose, migrations, durable outbox/worker and CI.
- Isolated anonymous draft workspace and UX-03–07 improvements.
- I1 code: signed OIDC verification, encrypted identity/linking, revocable HTTPS sessions and local admin bootstrap.
- I2: role-scoped invitations, explicit consent, atomic redemption and unused-link revocation/expiry.
- I3 private account drafts: save/reopen/edit/duplicate, ownership checks and locked material terms.
- Local NEAR sandbox prototype: source-bound escrow, principal recovery, signed attendance/reconciliation and first-round proof/recovery deadlines.
- P2 read-only pricing: pinned real-provider signature verification, strict request/principal checks and bounded transport; no payment instruction or enrollment.
- P4 local typed-construction proof: exclusive custody intent, fixed EVM/Core transfers and immutable pending signing images; no MPC signatures.
- Native NFT prototype: exact receipt/publication gate, fixed delivery/return with retry, draft/outage recovery and recomputed material-terms commitments.
- P5: all four public finalized-header pairs match; sandbox observer receipts gate custody readiness and reconcile only the fixed payout intent. Routes remain unqualified.
- 28 unit, 29 PostgreSQL, 15 Chromium and 24 sandbox scenarios covered; independent Node replays, build and Rust lint pass.
- Both CI jobs pass at `a381b4e`; this signed-observer checkpoint has a separate remote result.
- [Verification](docs/verification.md), [secure setup](docs/setup.md#secure-local-identity-setup), [isolation](docs/adr/0003-local-draft-workspace.md).

## Next action

Continue [the active halfway goal](docs/plan.md#active-halfway-implementation-goal):
P5 exact-asset observation normalization and external recovery, then I4–I5 commitments/recovery and A1–A4 attendance interfaces.
P2/G1/P3/G2 actual integrations remain gated; typed construction does not qualify an external route.
Google/Telegram registrations and callback proof remain owner/provider gates;
independent local work continues. Verified private-branch checkpoints are approved.
No merge, hosting, public signing/deployment, paid purchase or spending is authorized.

## Unimplemented or unverified

Live provider journeys, real attributable funding/publication, wallet commitments,
privacy operations and attendance interfaces. Contract evidence uses local test tokens;
external routes, live draw recovery, typed custody signing and observers remain unqualified.
Published-state tests are fixtures. Rewards/claims/reporting/release stay in milestones 5–7.
No mainnet, real-phone or full halfway completion is claimed.
