# Technical scope and evidence

Reviewed October 29, 2026. This document supports [SCOPE-01](plan.md).
It records source-backed constraints and proposals, not a completed integration
or an approved implementation plan. [The PRD](prd.md) remains the product authority.

## Scope confirmed with the owner

- Both digital live-code and physical staff-validated QR check-in must be ready
  before the first real pilot. They share the same commitment and settlement rules.
- Streaks are daily. Five consecutive qualifying days unlock a modest boost;
  continued daily attendance keeps it active. A missed, unprotected day resets
  progress and requires another five-day run. The multiplier does not escalate
  indefinitely. The PRD's exact 1.5x figure remains the proposed numeric default.
- Research and scoping are authorized. Application implementation, live spending,
  deployments, and repository visibility changes are not authorized by this review.

## Stack baseline and remaining selections

| Responsibility | PRD baseline | Evidence and remaining choice |
| --- | --- | --- |
| Website | TypeScript + React, responsive web, optional PWA | React recommends starting with a framework. Select framework, routing, rendering, and hosting together; React alone does not settle these. [React](https://react.dev/learn/creating-a-react-app) |
| API and execution | TypeScript API and durable workers | Keep financial retries independent of an open browser or HTTP request. Runtime, hosting, job library, and scheduler are still unselected. This is a product architecture proposal. |
| Private records | PostgreSQL | Database constraints can enforce record validity; cross-row rules need appropriate uniqueness, foreign keys, and transaction design rather than arbitrary CHECK expressions. ORM, migration tooling, provider, and job locking remain open. [PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html) |
| Money rules | Rust + near-sdk, one bounded NEAR contract | SDK supports asynchronous calls and fungible-token standards. Showup's escrow and recovery rules still need implementation and tests. [SDK](https://github.com/near/near-sdk-rs) |
| Cross-chain delivery | NEAR Intents / 1Click | Quotes and status tracking exist; secure registration attribution and outbound destination enforcement remain G1 proof obligations. [1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) |
| Identity | Telegram and Google login plus wallet ownership proof | Both document OpenID Connect (OIDC), a standard for verified sign-in. Select a maintained server-side authentication library; provider login does not prove wallet control. [Telegram](https://core.telegram.org/bots/telegram-login), [Google](https://developers.google.com/identity/openid-connect/openid-connect) |
| Messaging | One ordinary Telegram bot, no Mini App | Telegram explicitly exempts regular bots without a Mini App from its Mini App blockchain restrictions. Preserve the ordinary website wallet flow. [Guidelines](https://core.telegram.org/bots/blockchain-guidelines) |
| Draw proof | OutLayer candidate | Documented signatures and verification support investigation; they do not establish that Showup can enforce one request, prevent rerolls, or survive withholding. [OutLayer](https://app.outlayer.ai/docs/vrf) |

No dependency version is selected by these links. Context7 was used for React,
NEAR Intents, and near-sdk; primary documentation supplemented gaps. Exact
package versions, compatibility, release-age gates, audit results, and lockfiles
belong to the approved implementation setup. Do not install a documentation
example's version range as the project baseline.

## Funding and refunds: first proof obligation

The [quote reference](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
documents exact-output quoting and integer base-unit amounts. It documents
`customRecipientMsg` for NEAR `ft_transfer_call` delivery, labels it highly
experimental, and warns of fund loss for non-NEP-141 tokens, insufficient storage
registration, or a recipient without `ft_on_transfer`.

This is a possible implementation route, not a passed G1 gate. Required proof:

- The chosen USDC token contract, decimals, recipient registration, and storage
  costs are verified for the actual network. Token symbols are insufficient.
- The callback receives the intended registration message and exact principal.
- Source-wallet authorization binds event, rules, nonce, expiry, and payout
  destination; the identity service cannot substitute the destination.
- Failed, duplicate, late, underfunded, and excess deposits have recoverable outcomes.
- Outbound quotes and transfers cannot redirect a finalized entitlement or spend it twice.

The [status endpoint](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status)
tracks a deposit address and, when applicable, its memo. Keep both with the
funding attempt. Provider status must be reconciled with the token receipt and
Showup registration; it is not by itself evidence of contract enrollment.

The [SDK guide](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk)
says Intents has no testnet. Plan two distinct test environments: contract
sandbox/testnet tests with clearly identified test assets, and separately approved
small mainnet routing tests using isolated accounts. A dry quote is not a transfer.

The current [authentication guide](https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication)
supports a partner JWT in `X-API-Key` or `Authorization: Bearer`. It describes
an additional 25-basis-point unauthenticated fee for non-ANY_INPUT quotes and a
separate partner fee schedule. Generated API pages mark the header required
while the narrative describes unauthenticated access. Verify actual API/SDK
behavior before coding around either assumption; use current quotes for fees.
No account, token, or live transaction was created during this research.

## Contract obligations

NEAR's [token receiver guidance](https://docs.near.org/smart-contracts/security/cross-contract-calls/ft-transfer-call)
requires checking the predecessor token contract, with unused tokens returned
through the standard resolver. Showup must accept only its pinned settlement
asset and validate the registration payload before crediting a commitment.

NEAR's [callback guidance](https://docs.near.org/smart-contracts/security/callbacks)
explains that calls execute independently and other operations can run between
a request and its callback. Keep payout state safe while pending, restrict
callbacks to the contract, and reconcile failures explicitly. A failed external
call does not automatically repair Showup's accounting. Native-NEAR refund
examples are not a substitute for testing USDC transfer callbacks.

The PRD's conservation, replay, destination-substitution, concurrent settlement,
and callback failure checks remain required. Documentation review is not a
security audit or proof that these protections exist.

## Randomness: second proof obligation

NEAR documents [validator-related limitations of native randomness](https://docs.near.org/smart-contracts/security/random).
Do not replace the PRD's externally verifiable draw with a browser-selected
winner or a bare chain random seed.

OutLayer documents an Ed25519 signature over a message containing request ID,
sender, and seed; the output is the hash of that signature. Showup must verify
all those bindings and the frozen entry snapshot, not just signature validity.
Its documented service requires an OutLayer project and keystore. Provider
availability, cost, immutable key policy for funded events, one-request binding,
and timeout behavior remain untested.

There is also an example inconsistency: the docs forbid colons in user seeds
but show a multi-value example containing a colon. Follow the stated constraint
and validate the chosen seed encoding. Do not copy examples uncritically.

## Identity and phone experience

Telegram's current login documentation describes OIDC authorization-code login
with PKCE support; the older iframe widget is legacy. Register allowed origins
and redirect URLs, validate ID tokens server-side, and keep bot messaging
consent separate. Telegram does not provide a separate UserInfo endpoint, which
matters when selecting an OIDC library. Do not request phone numbers merely
because the provider supports them. [Telegram login](https://core.telegram.org/bots/telegram-login)

Google also requires registered OAuth credentials and redirect configuration.
Use a maintained verification library. Account linking, wallet challenges,
session security, and host/attendee data isolation remain Showup responsibilities.
[Google login](https://developers.google.com/identity/openid-connect/openid-connect)

Actual iOS/Android wallet return, audio continuity, notifications, camera scans,
and weak-network recovery still require devices. No source read establishes G3.

## Decisions needed before a build-ready plan

| Decision | Proposed treatment | Still needed |
| --- | --- | --- |
| First pilot | Both modes ready; one coherent event engine | Date, expected attendance, venue/staff availability, and phones for testing |
| Funding routes | Preserve PRD targets; prove one complete route before adding others | Initial external route order based on the pilot audience; qualification for every advertised route |
| Economics | Preserve the PRD's refund and no-show rules | Confirm numeric defaults, sponsor budget, and a separately approved integration-test spending cap |
| Frontend/API | Choose one coherent TypeScript framework/runtime | Hosting constraints and wallet/auth compatibility research before selection |
| Draw | Investigate OutLayer with contract-bound requests | G2 experiment; no funded random draw until it passes |
| Operations | Durable worker and recoverable records | Owner/provider choices for hosting, database, secrets, monitoring, and recovery |

The daily model assumes enough eligible events exist for a five-day run. That
is a supply and product-validation question, not a reason to change the confirmed
daily streak behavior. Repeated boosts alone are not evidence of retention.

Use [the plan](plan.md) for the proposed sequence and task status. No alternate
task tracker or implementation approval is created by this evidence document.
