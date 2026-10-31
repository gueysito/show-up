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

## Dependency and estimation boundary

The existing seven-outcome sequence remains the proposal; no implementation
stage is added or authorized. First resolve the NFT custody trust model and
same-request recovery support. Their proof obligations control the effort of
outcomes 2, 5 and 6, so a defensible total estimate is not available yet. Do not
promise a delivery date based only on library documentation.

For the next build-plan draft, attach task-level estimates to the chosen design,
including separate NEAR, EVM and Solana custody work, all four network qualification
runs, refunds/returns, fee caps, invitation/capacity races, and mainnet-security
verification. Identify tasks that can use engineering testnets versus those
requiring an approved real-funds budget. Operational shutdown must preserve
30-day claims and any accepted unresolved liabilities.
