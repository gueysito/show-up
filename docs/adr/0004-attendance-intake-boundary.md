# ADR-0004: Journal known attendance intake before processing

Local implementation decision, November 3, 2026. Live coverage remains unqualified.

## Decision

Within the authorized A3 local implementation, commit a minimal intake record
before an authenticated attendance mutation. A normal sandbox checkpoint must
refuse unresolved recorded work or a known service failure in the attendance
window. This boundary does not establish continuous or external ingress coverage.

## Context

The accepted-candidate barrier drains active candidate transactions. A process
can nevertheless die before its transaction commits, or after its durable
candidate/operation receipt commits and before acknowledging the request.
Counting only candidates cannot distinguish that interrupted intake from absence.

## Invariants

- Original server receipt time controls window inclusion; browser fields cannot
  supply time, health, environment or eligibility.
- The authenticated actor and owned consent or event assignment scope intake.
  Invalid/foreign and out-of-window requests cannot manufacture an outage.
- Intake, mutation and completion are separate durable steps. Normal closure
  drains both the candidate ledger and recorded pending intake under the event lock.
- An existing immutable operation receipt with the exact actor/request hash may
  resolve its interrupted retries. No new candidate, signature or financial right
  is manufactured. A business rejection resolves only its own recorded attempt.
- A known service failure stays latched after later recovery. Missing or unhealthy
  evidence cannot become a no-show allocation; timed fail-neutral remains available.
- Intake stores hashes and minimal timing/status, never phrases, QR payloads or
  wallet/social identity. Own export excludes operation IDs and hashes. Completed
  details expire after 90 days in bounded batches; event aggregates and unresolved
  work remain for reconciliation. Account erasure cannot erase the health aggregate.
- Accepted candidates and this known-intake journal are insufficient to sign a
  live completeness claim. Independent ingress/service coverage remains required.
- Normal checkpoint preparation additionally requires bounded coverage signed by
  the frozen evidence authority for the exact publication, registration and
  attendance windows. Every mode-specific channel must be present, contiguous,
  resolved and free of reported failures, with nonregressing exact counters and
  at least its known intake. I4 fixes registration close at event start.
- A valid signature authenticates a collector's claim; it does not qualify its
  measurements. All enabled ingress behind each logical channel must be measured.
  New transports require renewed deployment/collector qualification. No HTTP
  parameter, health boolean or signed test fixture can enable a live route.

## Consequences

A request can commit its candidate yet receive an unavailable response while
completion persistence fails. Retry preserves the original operation and repairs
that journal boundary. An unreconciled interruption conservatively blocks normal
closing. No live source qualification, public signing or route enablement follows.

## Rejected alternatives

- Candidate counts alone omit interrupted work.
- Recording intake only inside the candidate transaction loses both on rollback.
- Clearing a service failure after one successful retry cannot establish that
  other affected requests were received.

## File references and verification

Implementation: `src/server/attendance/intake.ts`, `coverage.ts`, `journal.ts`, migrations 023–025
and the existing attendance mutations. PostgreSQL checks kill actual processes
before and after candidate commit, recover the original operation, test failure
latching, actor/timing exclusions, export and bounded retention. These are local
engineering checks; bounded coverage/signature/gap and frozen checkpoint checks
include independent Rust/Node fixture bytes. Those fixtures are unmeasured claims;
qualified ingress collection and actual-device evidence remain open.
