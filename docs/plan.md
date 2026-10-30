# Showup plan

This is the single task tracker. Requirements live in [the PRD](prd.md);
maturity and the next action live in [current state](../CURRENT_STATE.md).
No implementation stages are approved yet.

| ID | Status | Outcome and acceptance | Evidence |
| --- | --- | --- | --- |
| REPO-01 | Complete | Private `gueysito/show-up` repository; navigable front door; product-only requirements; active commit template and checks; no application implementation. | [README](../README.md), [agent instructions](../AGENTS.md), [standards](../.standards/README.md). Initial commit verification covers links, scope, baseline checks, and rejection of an incomplete commit message. |
| SCOPE-01 | NOW | Discuss audience, full event loop, proposed economic defaults, integration gates, and evidence needed to assess product-market fit. Completion requires the owner's recorded decisions before an implementation plan is approved. | [Technical scope](technical-scope.md) records the October 29 documentation review and confirmed pilot/streak decisions. Remaining choices and the proposed sequence below are not yet approved for implementation. |

REPO-01 is the repository setup checkpoint. SCOPE-01 authorizes discussion only.
Do not expand the roadmap or change acceptance criteria without owner approval.

## Proposed build order for scope discussion

This is a proposal within SCOPE-01, not approved implementation stages. It
preserves the PRD's scope and acceptance criteria; it does not authorize code,
provider accounts, spending, or deployments. The first pilot follows both
attendance modes and the complete money loop, not a partial digital-only build.

| Order | Proposed outcome | Existing acceptance and dependency |
| --- | --- | --- |
| 1 | Confirm scope, numeric defaults, network boundaries, and stack selections | Owner decisions and a versioned deployment plan; PRD G6 |
| 2 | Prove attributable deposit-to-refund routing and independently verified draw behavior | G1 and G2; investigate both before committing the rest of the architecture |
| 3 | Establish identity, wallet binding, event rules, escrow, releases, and recovery | G5; MONEY-01 through MONEY-06; CANCEL-01; PRIV-01 |
| 4 | Complete digital codes and physical QR/staff flows against the same event engine | ATT-01 through ATT-03; LIVE-01 and LIVE-02; both modes required before pilot |
| 5 | Add quizzes, daily streaks, reward presets, draw, and optional bot interactions | QUIZ-01 through QUIZ-03; STREAK-01 through STREAK-03; DRAW-01 through DRAW-03 |
| 6 | Finish destination delivery, receipts, host reports, and supported-route qualification | G1 per enabled route; MONEY checks; REPORT-01; no pending payment represented as delivered |
| 7 | Validate complete journeys on phones and prepare the first pilot | G3; UX-01 and UX-02; full enabled-feature acceptance matrix; optional G4 only if verified |

Device probes should start during early integration work, with full end-to-end
checks at order 7. Refining this proposal into tasks requires estimates,
dependency links, evidence commands, and owner approval. PRD §20 remains the
authority for pass conditions; those conditions are not replaced by this table.
