# Showup plan

This is the single task tracker. Requirements live in [the PRD](prd.md);
maturity and the next action live in [current state](../CURRENT_STATE.md).
No implementation stages are approved yet.

| ID | Status | Outcome and acceptance | Evidence |
| --- | --- | --- | --- |
| REPO-01 | Complete | Private `gueysito/show-up` repository; navigable front door; product-only requirements; active commit template and checks; no application implementation. | [README](../README.md), [agent instructions](../AGENTS.md), [standards](../.standards/README.md). Initial commit verification covers links, scope, baseline checks, and rejection of an incomplete commit message. |
| SCOPE-01 | NOW | Discuss audience, full event loop, proposed economic defaults, integration gates, and evidence needed to assess product-market fit. Completion requires the owner's recorded decisions before an implementation plan is approved. | [Technical scope](technical-scope.md) records platform evidence, confirmed pilot/streak/network choices, and framework/partner recommendations. Base is the default EVM route; Ethereum remains required. Recommendations are not implementation approval. |

SCOPE-01 evidence: the [framework compatibility review](technical-scope.md#framework-compatibility-review)
confirms framework-independent wallet paths and documents the Better Auth /
Telegram email mismatch in both frameworks. [ADR-0001](adr/0001-application-and-authentication.md)
records accepted Next.js, Node.js, openid-client, and PostgreSQL-backed sessions.
Session/linking implementation and live verification remain build tasks.
October 31 checkpoint: owner-approved interview decisions are reconciled in
[PRD sections 7–16](prd.md) and the
[remaining decision register](technical-scope.md#decisions-needed-before-a-build-ready-plan).
Docker Compose/Railway and invitation-only mainnet are accepted. Economics,
attendance, NFT prizes, claims/redraws, and reduced testing deposits are recorded.
Latest checkpoint also records capped fee deductions, three same-request draw
attempts within a provisional two-minute window, all-funds-return aborts, locked
capacity/material terms, and host/attendee invitation rules. SCOPE-01 remains
open for custody/proof design, provider validation, funding/operations and build approval.
The [consolidated recommendation](technical-scope.md#consolidated-technical-recommendation)
groups the remaining technical choices and distinguishes proposals from accepted policy.
Verification: repository standards, whitespace, local Markdown links, and
product-only content checks; no application or security validation is claimed.


REPO-01 is the repository setup checkpoint. SCOPE-01 authorizes discussion only.
Do not expand the roadmap or change acceptance criteria without owner approval.

## Proposed build order for scope discussion

This is a proposal within SCOPE-01, not approved implementation stages. It
preserves the PRD's scope and acceptance criteria; it does not authorize code,
provider accounts, spending, or deployments. The first pilot follows both
attendance modes and the complete money loop, not a partial digital-only build.

| Order | Proposed outcome | Existing acceptance and dependency |
| --- | --- | --- |
| 1 | Finish unresolved financial recovery, NFT custody, provider and operational decisions | Owner decisions and a versioned deployment plan; PRD G6 |
| 2 | Prove attributable deposit-to-refund routing and independently verified draw behavior | G1 and G2; include authorized redraw rounds and NFT custody/release proofs on all four chains before dependent implementation |
| 3 | Establish identity, wallet binding, event rules, escrow, releases, and recovery | G5; MONEY-01 through MONEY-06; CANCEL-01; PRIV-01; invitation redemption and restricted-access limits |
| 4 | Complete digital codes and physical QR/staff flows against the same event engine | ATT-01 through ATT-03; LIVE-01 and LIVE-02; both modes required before pilot |
| 5 | Add quizzes, daily streaks, reward presets, draw, and optional bot interactions | QUIZ-01 through QUIZ-03; STREAK-01 through STREAK-03; DRAW-01 through DRAW-03; CLAIM-01/02 and NFT-01/02 |
| 6 | Finish destination delivery, receipts, host reports, and supported-route qualification | G1 per required route; independent money/NFT delivery, returns and recovery; MONEY checks; REPORT-01; no pending payment represented as delivered |
| 7 | Validate complete journeys on phones and prepare the first pilot | G3; UX-01 and UX-02; full enabled-feature acceptance matrix; optional G4 only if verified |

Device probes should start during early integration work, with full end-to-end
checks at order 7. Refining this proposal into tasks requires estimates,
dependency links, evidence commands, and owner approval. PRD §20 remains the
authority for pass conditions; those conditions are not replaced by this table.

## Planning constraints for the next discussion

The proposal above now includes the approved single-NFT and claim/redraw scope;
it is not an implementation estimate. Before approval, break each outcome into
bounded tasks with prerequisites, expected effort, evidence commands, and stop
conditions. Do not estimate four-chain custody as one interchangeable adapter.
Resolve the financial decision register first so estimates describe one coherent
money model. No new tracker stages are created by this reconciliation.

The restricted release must prove real cross-chain deposit-to-refund journeys,
both attendance modes, invitation isolation, budget enforcement, and prize
custody/accept/decline/return behavior. Security checks precede any mainnet
exposure. Mainnet transaction amounts, deployment, and spending need explicit
approval; a product decision or documentation commit does not grant it.

## Implementation plan for approval

This expands the existing seven proposed outcomes into executable milestones;
it does not create a second tracker or authorize implementation/deployment.
Owner accepted contract-enforced custody. [ADR-0002](adr/0002-nft-custody.md)
specifies the proposed protocol and the remaining observation trust decision.
Planning work is complete for this checkpoint; SCOPE-01 remains NOW until review.

Effort ranges are engineering workdays (roughly six focused hours), not elapsed
AI execution time or a delivery promise. They include implementation and focused
verification, exclude external waiting/audits and assume the proposed attested
observation model is accepted. Full cryptographic cross-chain proofs require a
new estimate. Confidence is low until the early protocol experiments conclude.

| Existing outcome | Work and dependency | Effort | Completion evidence |
| --- | --- | --- | --- |
| 1: Foundation | Pin stable versions with supply-chain checks; Next.js/web, worker, PostgreSQL, migrations, outbox, Docker Compose, CI format/lint/typecheck/tests; fail-closed configuration. No external funding required. | 2–3 days | Clean clone starts locally; migrations and job recovery work; no visitor simulation or secrets in bundles. |
| 2: Protocol proofs | After minimal foundation, prove G1 token attribution/destination binding, G2 same-request recovery, and ADR-0002 signed payload/intent enforcement. NEAR sandbox first; EVM/Solana engineering networks next. Mainnet Intents portion waits for separately approved funds. | 4–7 days | Round-trip trace, independent draw verification, mutated-field/replay/race rejection, custody transfer and return on each family. Pause dependent integration if provider cannot meet invariants. |
| 3: Identity and commitments | After foundation; proceed independently of unresolved NFT observation. OIDC sessions/linking, nonce-based wallet binding, host/attendee invitations, event rules, fee caps, capacity reservations, commit/release/late-return accounting. | 4–6 days | G5, PRIV-01, INVITE-01/02, CAPACITY-01, MONEY-01–06 and cancellation authorization. No real transfers until G1 passes. |
| 4: Both attendance modes | After identity/commitments. Three-minute fresh code words, bound Telegram prompt, staff QR scan, exact windows, evidence outage handling; begin actual-phone tests here. | 3–4 days | ATT-01–03, LIVE-01/02; phone camera, app return and audio checks; no manual overrides. |
| 5: Rewards and prizes | After attendance and protocol proofs. Quizzes, 1.25× streak, three presets, bound draw rounds, acceptance/typed decline, 30-day deadline, native NEAR NFT custody and external signing adapters. | 5–8 days | QUIZ/STREAK/DRAW/CLAIM/NFT matrix; freeze/abort/expiry/retry tests; contributor exclusions; two-minute target measured. |
| 6: Delivery and operations | After money and reward engines. Idempotent routes, fee deduction/net receipts, NFT finality, recovery queues, reports, all four network qualification. Design backup/restore, caps and shutdown continuity before hosting. | 3–5 days | Destination receipts and reconciled reports; no double payment or stranded unknown liabilities; restore/restart recovers pending work. |
| 7: Integration and release review | After all prior outcomes. Adversarial auth/data/money tests, 100-seat concurrency/load, complete digital/physical journeys, clean-clone reproduction and recovery rehearsal. Mainnet activation only with explicit budget/deployment approval. | 3–5 days | G1–G6 where applicable, complete acceptance matrix, security findings resolved for restricted exposure; optional G4 absence honestly disclosed. |

Total planning range: **24–38 engineering workdays**, before external waiting or
independent audit. Some foundation/identity work can overlap protocol investigation;
do not subtract overlap before assigning actual capacity. Four-network NFT custody
and cross-chain authorization dominate uncertainty. No network or attendance mode
is removed to fit a calendar. If a milestone exceeds twice its estimate, stop and
reforecast with evidence, rather than silently reducing acceptance.

### Verification commands to establish in outcome 1

Use the chosen package manager's locked install and exact scripts for `format:check`,
`lint`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, and `build`; Rust
contract checks use `cargo fmt --check`, `cargo clippy`, and `cargo test` plus the
selected sandbox runner. These are planned commands, not currently available.
Keep existing repository hooks active. Separate tests requiring external providers
or funds from offline CI so CI cannot unexpectedly spend real money.

### Security and stop conditions

Check server authorization, user-to-user ID swaps, admin access, rate limits,
error redaction, input/query handling, CSRF/CORS, server secret isolation, dependency
advisories and production debug defaults. Avoid uploads initially; remote NFT
metadata fetching needs SSRF/size/time limits. Money tests cover conservation,
callback failure, replay, fee cap enforcement, destination substitution and every
claim/timeout/return race. Test deterministic transitions, not merely mocks.

A provider failure cannot be patched with a platform hot wallet, unrestricted
signing or new draw request. Native-chain and cross-chain proofs remain separate.
External attestation needs explicit approval before NFT publication. No production
security claims follow from documentation or a passing unit test alone.

### What requires the owner, and when

- Before external NFT custody integration: accept the observation trust proposal
  in ADR-0002 or require a cryptographic proof alternative. This is the one remaining
  custody decision; it does not block local foundation/identity work after plan approval.
- Before implementation: approve this plan. Routine package/version selection and
  test implementation belong to engineering; return only for material scope/risk changes.
- Before mainnet experiments: approve public wallet addresses, exact route quotes,
  total and per-attempt caps, fee/service budgets. No secret values in planning docs.
- Before hosting: approve deployment destination, operating budget, recovery and
  security evidence. Preserve claim access and accepted liabilities after shutdown.
