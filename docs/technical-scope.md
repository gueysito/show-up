# Technical scope and evidence

Reviewed October 29, 2026. This document supports [SCOPE-01](plan.md).
It records source-backed constraints and proposals, not a completed integration
or an approved implementation plan. [The PRD](prd.md) remains the product authority.

## Scope confirmed with the owner

- [ADR-0001](adr/0001-application-and-authentication.md) accepts Next.js + TypeScript
  on Node.js and openid-client for Telegram/Google login with PostgreSQL-backed
  sessions. Authentication selection is resolved; live verification is normal
  implementation work. Hosting remains undecided.
- Base is the default EVM network; Ethereum mainnet must also be available.
  Prefer low total cost and fast delivery when recommending eligible routes;
  compare current quotes rather than claiming one network is always cheapest.
  Never silently change a user's authorized network or payout destination.
- Wallet targets are Phantom, Rabby, and a selected NEAR wallet. Solana and NEAR
  remain in scope alongside Base and Ethereum. Route tests qualify support;
  they do not authorize silently removing a required network from the release.
- The owner intends to use existing development wallets for transaction tests.
  Specific accounts, supported test networks, and live-test budgets are not yet
  identified or authorized. No wallet connection or key inspection has occurred.
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
| Website | TypeScript + React, responsive web, optional PWA | React recommends starting with a framework. Next.js App Router is accepted in ADR-0001; hosting remains open. [React](https://react.dev/learn/creating-a-react-app) |
| API and execution | TypeScript API and durable workers | Keep financial retries independent of an open browser or HTTP request. Node.js is accepted; hosting, job library, and scheduler remain open. This is a product architecture proposal. |
| Private records | PostgreSQL | Database constraints can enforce record validity; cross-row rules need appropriate uniqueness, foreign keys, and transaction design rather than arbitrary CHECK expressions. ORM, migration tooling, provider, and job locking remain open. [PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html) |
| Money rules | Rust + near-sdk, one bounded NEAR contract | SDK supports asynchronous calls and fungible-token standards. Showup's escrow and recovery rules still need implementation and tests. [SDK](https://github.com/near/near-sdk-rs) |
| Cross-chain delivery | NEAR Intents / 1Click | Quotes and status tracking exist; secure registration attribution and outbound destination enforcement remain G1 proof obligations. [1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) |
| Identity | Telegram and Google login plus wallet ownership proof | Both document OpenID Connect (OIDC), a standard for verified sign-in. openid-client with PostgreSQL-backed sessions is accepted in ADR-0001; provider login does not prove wallet control. [Telegram](https://core.telegram.org/bots/telegram-login), [Google](https://developers.google.com/identity/openid-connect/openid-connect) |
| Messaging | One ordinary Telegram bot, no Mini App | Telegram explicitly exempts regular bots without a Mini App from its Mini App blockchain restrictions. Preserve the ordinary website wallet flow. [Guidelines](https://core.telegram.org/bots/blockchain-guidelines) |
| Draw proof | OutLayer candidate | Documented signatures and verification support investigation; they do not establish that Showup can enforce one request, prevent rerolls, or survive withholding. [OutLayer](https://app.outlayer.ai/docs/vrf) |

No dependency version is selected by these links. Context7 was used for React,
NEAR Intents, and near-sdk; primary documentation supplemented gaps. Exact
package versions, compatibility, release-age gates, audit results, and lockfiles
belong to the approved implementation setup. Do not install a documentation
example's version range as the project baseline.

## Framework and partner recommendations for discussion

Framework and authentication are accepted in ADR-0001. Other entries remain
recommendations for owner discussion. No provider is provisioned by this list.

| Area | Recommendation | Why and qualification |
| --- | --- | --- |
| Web framework | Next.js App Router with TypeScript | Keep event pages, host UI, and HTTP API in one application. Node and Docker deployment are supported, so this does not select Vercel. Use a server deployment, not static export, for authenticated dynamic routes. [Next.js](https://nextjs.org/docs/app/getting-started/deploying) |
| Long-running operations | Separate Node worker using pg-boss | PostgreSQL-backed jobs avoid adding a second queue datastore initially. Transactional job creation and retries are documented. Retried jobs still need application-level payment idempotency and chain reconciliation; the queue cannot guarantee an external transfer occurs only once. [pg-boss](https://github.com/timgit/pg-boss) |
| Database access | PostgreSQL with Drizzle | Explicit SQL-like queries and typed schema suit financial state and uniqueness rules. Review generated migrations; the contract remains authoritative for on-chain money. [Drizzle](https://orm.drizzle.team/docs/overview) |
| UI components | shadcn/ui as a starting point | Component source is owned in the application and can be adapted for phone check-in and wallet states. Accessibility and actual device behavior still need testing. [shadcn/ui](https://ui.shadcn.com/docs) |
| Managed hosting | Render web service, background worker, and paid PostgreSQL as one candidate | Documented support covers all three runtime needs. Co-locate services. Paid Postgres provides point-in-time recovery; run an actual restore test. Compare with the owner's existing infrastructure before purchasing. [Web](https://render.com/docs/deploy-nextjs-app), [workers](https://render.com/docs/background-workers), [recovery](https://render.com/docs/postgresql-backups) |
| Existing-server alternative | Same Node/container layout on an owner-selected existing host | Potentially avoids a new compute bill but requires capacity, isolation, backups, patching, monitoring, and recovery checks. No server has been inspected and no capacity or cost saving is established. Remote inspection needs its own authorization. |
| Authentication | Accepted: openid-client for provider login and PostgreSQL-backed application sessions | Source-verified protocol fit for Telegram without email or UserInfo, and Google OIDC. Session lifecycle and explicit account linking require application work; live proof remains outstanding. See the authentication resolution below. |
| EVM wallets | Wagmi + viem for Rabby on Base and Ethereum | Candidate typed EVM connection layer. Verify Rabby discovery, chain switching, signatures, transactions, and mobile returns. [Wagmi](https://wagmi.sh/react/getting-started) |
| Solana wallet | Phantom through its documented provider or Solana Wallet Adapter | Choose the smallest supported integration after desktop/mobile signature and funding checks. A connector does not supply a cross-chain escrow adapter. [Phantom](https://docs.phantom.com/solana/integrating-phantom) |
| NEAR wallet | Evaluate HOT Connect before defaulting to Wallet Selector | The Wallet Selector repository recommends exploring HOT Connect while remaining supported during transition. Confirm the owner's wallet, testnet support, signature format, mobile return, and integration boundaries before adopting. [NEAR Wallet Selector](https://github.com/near/wallet-selector) |
| Transfers and draw | Keep 1Click and OutLayer as gated candidates | Preserve G1 and G2 below. A documented feature or preferred ecosystem integration is not a passed experiment. |

The proposed runtime shape is: browser and ordinary bot to the Next.js API;
API to private PostgreSQL records and job queue; a separate worker to external
providers and the NEAR contract. The worker submits authorized actions and
reconciles results; it cannot choose beneficiaries or alter finalized amounts.

Hosting selection also needs a domain, region, baseline monthly budget, secret
storage, log redaction, alert destination, database recovery policy, and staging
separation. Choose these together; do not silently create paid accounts. Current
[Render pricing](https://render.com/pricing) separates workspace fees, compute,
database storage, and usage. Its smallest listed paid web/worker/database compute
combination totals $20/month before extras; this is a price floor, not a measured
capacity recommendation or an approved budget.

RPC/indexing provider, error monitoring vendor, exact NEAR wallet,
and test-library versions remain open. Compare existing accounts and
requirements before introducing another paid service. Package selection needs
compatible stable versions and supply-chain checks before installation.

## Framework compatibility review

Reviewed October 29, 2026 against current official documentation and the source
noted below. This is documentation/source verification, not an installed build,
wallet session, transaction test, or security audit. No package versions are
approved. Hosting remains undecided while the owner investigates existing access.

The recommendation is Next.js + TypeScript on Node.js for lower wallet UI
integration effort. SvelteKit is technically viable; it is not rejected for an
incompatibility. No benchmark establishes that either framework is faster for
Showup. The earlier Next.js proposal was not a fully validated combination.

| Boundary | Finding | Consequence |
| --- | --- | --- |
| Rabby / Base / Ethereum | [Rabby](https://rabby.io/docs/integrating-rabby-wallet) documents plain JavaScript discovery as well as React integration. [Wagmi Core](https://wagmi.sh/core/api/connectors/injected) supports injected providers and EIP-6963 discovery. | Svelte can use Core + viem; React has ready-made hooks. Svelte needs its own subscriptions and component state. Some Rabby examples use older Wagmi APIs; use the selected version's documentation. |
| Phantom / Solana | [Phantom](https://docs.phantom.com/solana/integrating-phantom) documents direct browser-provider integration. Its [React SDK](https://docs.phantom.com/sdks/react-sdk) provides hooks and a modal. | No Svelte blocker. Browser injection and external mobile wallet return are different flows. New Phantom Portal applications are currently paused; injected-only SDK usage does not require a Portal app. Do not depend on new embedded-wallet enrollment. |
| NEAR wallet | Official [NEAR documentation](https://docs.near.org/web3-apps/tutorials/wallet-login) identifies `@hot-labs/near-connect`; its [source and guide](https://github.com/azbang/near-connect) expose events, connection, message signing, and transactions without React. | Resolve the earlier HOT Connect naming to this package. Svelte needs a browser-only wrapper with listener cleanup. Filter for message signing and testnet support; support is wallet-specific. The actual wallet remains an owner choice. |
| HOT Kit | [HOT Kit](https://github.com/hot-dao/kit) is a different multichain package whose browser setup requires React and React DOM. | Do not confuse it with NEAR Connect. It is not required by our direct wallet + 1Click design. Adopting its UI would favor React. |
| UI components | [shadcn-svelte](https://www.shadcn-svelte.com/docs/installation/sveltekit) documents SvelteKit installation. | A documented Svelte alternative exists; React shadcn/ui components cannot simply be reused. |
| Google / sessions | Better Auth has official [SvelteKit integration](https://www.better-auth.com/docs/integrations/svelte-kit) and [Google setup](https://www.better-auth.com/docs/authentication/google). | Svelte integration itself is supported. Its documentation distinguishes SvelteKit 2 and 3 imports; select matching stable versions. |
| Telegram login | [Telegram](https://core.telegram.org/bots/telegram-login) returns identity in the ID token, no email, and no separate UserInfo endpoint. [Better Auth](https://www.better-auth.com/docs/concepts/oauth) explicitly requires email and documents missing-email failure. | The proposed Better Auth generic OAuth route fails our email-less login requirement in both SvelteKit and Next.js. Placeholder email or forced Google linking would alter requirements and is not adopted. |
| PostgreSQL / jobs / transfers | [Drizzle](https://orm.drizzle.team/docs/get-started-postgresql) documents Node PostgreSQL drivers; [pg-boss](https://github.com/timgit/pg-boss) runs on Node/PostgreSQL; [1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk) supplies a TypeScript SDK. | These server responsibilities do not depend on React or Svelte. Keep the worker separate from request lifetimes. No runtime version is selected from examples. |
| Draw verification | [OutLayer](https://app.outlayer.ai/docs/vrf) describes WASI execution and signed outputs. | UI framework is not the integration boundary. G2 remains unproven for either framework. |

### Authentication alternative examined

[Auth.js](https://authjs.dev/guides/configuring-oauth-providers) documents custom
OIDC providers for SvelteKit and Next.js, and a [Drizzle adapter](https://authjs.dev/getting-started/adapters/drizzle).
Source inspected on its development branch, revision
`a1a16a5a7780488c7449feece410033f445d0b31`, shows nullable email in the
[PostgreSQL adapter](https://github.com/nextauthjs/next-auth/blob/a1a16a5a7780488c7449feece410033f445d0b31/packages/adapter-drizzle/src/lib/pg.ts).
However, its [OAuth callback](https://github.com/nextauthjs/next-auth/blob/a1a16a5a7780488c7449feece410033f445d0b31/packages/core/src/lib/actions/callback/oauth/callback.ts)
rejects discovery metadata without a UserInfo endpoint, even though a later OIDC
path can use ID-token claims. Therefore an issuer-only Telegram configuration is
not sufficient. Explicit endpoint configuration is a candidate, not verified here.
Its [maintainers](https://github.com/nextauthjs/next-auth) now recommend Better Auth
for new projects except specific feature gaps. Do not silently replace one
unproven auth recommendation with another.

### Authentication resolution: documented protocol fit

Accepted on October 29, 2026 in [ADR-0001](adr/0001-application-and-authentication.md):
`openid-client` v6 for Telegram and Google
OpenID Connect (OIDC), with revocable application sessions in PostgreSQL.
OIDC is the protocol for verifying an identity supplied by another service.
This is an accepted design, not approval to install dependencies or begin the
build. Next.js remains the accepted framework direction.

Evidence was checked against the published [v6.8.8 release](https://github.com/panva/openid-client/releases/tag/v6.8.8)
and its [source](https://github.com/panva/openid-client/blob/v6.8.8/src/index.ts),
not only a development branch. This is a research baseline, not a dependency pin
or an advisory audit. The `authorizationCodeGrant` implementation does not call
`fetchUserInfo` or require an email. `tokens.claims()` returns validated ID-token
claims; UserInfo is a separate optional operation. The upstream
[OIDC example](https://github.com/panva/openid-client/blob/v6.8.8/examples/oidc.ts)
includes UserInfo and token logging as later steps: neither should be copied
into the Telegram integration or application logging.

| Requirement | Concrete treatment and evidence |
| --- | --- |
| Telegram without email | Request `openid profile`, use the verified issuer and subject as identity, and allow email to be null. Telegram's [live discovery metadata](https://oauth.telegram.org/.well-known/openid-configuration) publishes code flow, S256 PKCE, token endpoint authentication, and signing keys; it has no UserInfo endpoint or email scope. |
| No UserInfo request | Complete the code exchange, validate the ID token, and read `tokens.claims()`. Do not call `fetchUserInfo`. This uses the library's normal API rather than a fake endpoint or provider patch. |
| Signature verification | Explicitly enable [enableNonRepudiationChecks](https://github.com/panva/openid-client/blob/v6.8.8/docs/functions/enableNonRepudiationChecks.md). The library otherwise permits relying on the direct TLS token response; the accepted design requires cryptographic signature checking against the provider's published keys. Require ID token, issuer, audience, expiry and nonce validation, plus state and S256 PKCE. |
| Telegram token authentication | Use the documented `ClientSecretBasic` method, matching [Telegram's login guide](https://core.telegram.org/bots/telegram-login). Keep secrets and code exchange server-side. Use provider-specific registered callback URLs and fixed provider configurations. |
| Google | Use the same library with Google's issuer and its own credentials/callback. [Google documents](https://developers.google.com/identity/openid-connect/openid-connect) code exchange and identity from the ID token. Email, if requested, is profile data rather than the identity primary key. |
| Sessions | Showup must implement opaque random session tokens in Secure, HttpOnly, SameSite cookies, hashed server-side session records, expiration, rotation on login, and logout/revocation. The library does not supply this layer. All protected operations resolve the session server-side. |
| Explicit linking | Store provider identities with a unique `(issuer, subject)` key mapped to a Showup user. Linking requires an authenticated session and a fresh successful login to the second provider; bind the one-use attempt to that session and linking intent. Never merge by matching email, username, or display name. Reject identities already owned by another user; account merging needs a separate policy. |
| Wallet ownership | Wallet proof remains a separate nonce/signature flow. A Telegram or Google session cannot establish wallet ownership or authorize a payout destination change by itself. |

This resolves the known library mismatches at the documentation/source level.
It is not a turnkey auth suite: session lifecycle, linking, login-attempt storage,
rate limits, safe redirects, and authorization remain application responsibilities.
The tradeoff is explicit application work instead of another hosted identity
provider or compatibility patches. Better Auth and the inspected Auth.js default
configuration remain unsuitable as previously proposed. No provider account,
credential, dependency installation, login, or transaction was used in this review.

Before claiming operational readiness, the approved implementation must prove:

- Telegram-only signup with null email, Google signup, returning login and session restore.
- Reject missing/invalid signatures, wrong issuer/audience, expired tokens,
  wrong state/nonce/PKCE, replayed callbacks, and cross-provider callback confusion.
- Logout and expiration revoke access; linking requires the initiating session,
  handles conflicting ownership and concurrent attempts, and does not merge by email.
- Login cancellation and actual phone/browser redirects recover without losing intent.

A live proof requires registered Telegram and Google applications and allowed
callback URLs. Provider selection does not require a hosting vendor yet, but
successful live login has not been established by these read-only checks.

### Decision consequence

Next.js is accepted for the owner's stated priority of documented integrations
with less custom UI wiring. The accepted openid-client approach resolves the known
protocol mismatch. Session/linking work and live-flow verification are normal
implementation tasks, not unresolved architecture questions.
This review does not authorize a prototype or add roadmap stages.

Framework choice does not remove G1 cross-chain escrow/refund proof, G2 draw
verification, or G3 actual-device wallet return tests. No live access was used.

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

| Priority | Decision | Still needed |
| --- | --- | --- |
| 1 | Hosting and operations | Owner's existing Hostinger option versus a new provider; available plan, Node/worker support, PostgreSQL, region, domain, budget, backups, and staging arrangement. No server access or provider purchase is authorized. |
| 2 | Remaining libraries and services | Confirm Drizzle, pg-boss, UI components, RPC provider, monitoring, and the proposed wallet connectors. Exact versions and advisories are implementation setup work. |
| 3 | Wallets and test funding | Select the NEAR wallet and development accounts by public address; define testnet coverage and a small separately authorized mainnet routing budget. Base, Ethereum, Solana, and NEAR scope stays fixed. |
| 4 | Event economics and timing | Confirm exact streak factor, sponsor split/budget, capacity, deposit example, check-in windows, and timeout defaults from PRD sections 7 and 13. Do not reopen the accepted daily streak model or refund/no-show rules. |
| 5 | Draw and cross-chain providers | Confirm 1Click and OutLayer as the implementation candidates. Existing G1/G2 tests still determine operational readiness, not framework selection. |
| 6 | Pilot and build plan | Confirm audience size, event timing, venue/staff, and test phones; both attendance modes precede the pilot. Convert the existing proposed sequence into the approved implementation plan. |

The daily model assumes enough eligible events exist for a five-day run. That
is a supply and product-validation question, not a reason to change the confirmed
daily streak behavior. Repeated boosts alone are not evidence of retention.

Use [the plan](plan.md) for the proposed sequence and task status. No alternate
task tracker or implementation approval is created by this evidence document.
