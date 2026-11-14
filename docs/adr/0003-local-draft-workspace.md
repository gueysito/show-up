# ADR-0003: Local draft workspace

Status: Implemented under the owner's November 2, 2026 bounded authorization.

## Decision

Keep draft persistence in an opt-in development workspace, separate from future
provider authentication. The production build serves a rules preview and refuses
all workspace reads, writes and the workspace page, even with the harness flag set.

## Context

The owner approved an inspectable I3 draft subset without credentials, account
registration, funding or a production authentication bypass. ADR-0001 still governs
future real identities. Local data is disposable and must use fictional details.

## Invariants

- The harness requires development mode, an explicit development/test environment,
  the harness flag and a fixed loopback origin. Host/origin/header checks apply to
  its API. Docker publishes only loopback ports.
- A random HttpOnly/SameSite cookie identifies a browser workspace for 24 hours.
  Only its hash is stored. This is a local harness capability, not a host identity.
- Scope every draft query/mutation to that workspace. Revision checks prevent
  stale overwrites. Stable operation IDs replay the committed receipt.
- Commit the draft, mutation receipt and outbox record in one transaction.
  Outbox payloads contain IDs/revisions, never private question answers.
- No publication, funding, signing, fee quotation or contract claim is available.
- Do not promote workspace records into real host accounts or production events.
  Authenticated persistence remains a separate approved implementation task.

## Consequences and rejected alternatives

A public demo with invented balances or transactions was rejected. A production
flag that skips login was rejected. Browser-only storage would not exercise actual
database transactions, so it is used only for transient form state, not saved drafts.
The development workspace uses the real PostgreSQL, validation and outbox layers.

Next.js development assets explicitly allow `127.0.0.1`: Docker binds the server
to `0.0.0.0`, which otherwise fails its live-reload origin check. This setting does
not relax the workspace API's fixed origin or enable production access.

## References and verification

- [Guards](../../src/server/harness/guard.ts), [draft service](../../src/server/events/drafts.ts),
  [API](../../src/app/api/dev/drafts/route.ts), [schema](../../migrations/002-event-drafts.sql).
- Unit, PostgreSQL and browser tests cover production refusal, cross-workspace
  IDs, replay, races, expiry, shared rate limits, deletion and malformed input.
- [Review guide](../verification.md) records actual results and remaining limits.
