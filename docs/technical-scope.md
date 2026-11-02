# Technical scope and evidence

Technical sources reviewed October 29, 2026; owner decisions reconciled October 31, 2026. This document supports [SCOPE-01](plan.md).
It records source-backed constraints and proposals, not a completed integration
or an approved implementation plan. [The PRD](prd.md) remains the product authority.

November 2 implementation update: the owner authorizes the larger halfway slice,
P1–P5, I1–I5, A1–A4 and UX-03–07, preserving F1–F4.
Current evidence and status live in [the plan](plan.md). Approval statements below
describe the earlier research checkpoint, not the current bounded authorization.

### Halfway provider preflight, November 2

Revalidated primary documentation, not live capability:

- [Telegram login](https://core.telegram.org/bots/telegram-login) requires a bot,
  registered allowed origin/redirects and OIDC client credentials. Google requires
  its own [OAuth client and callback registration](https://developers.google.com/identity/openid-connect/openid-connect).
  Both live proofs await operator configuration. Request only `openid profile`;
  no email, phone or messaging permission is required for authentication.
- [openid-client v6.8.8](https://github.com/panva/openid-client/blob/v6.8.8/docs/functions/enableNonRepudiationChecks.md)
  supports explicit ID-token signature checks and state/nonce/S256 PKCE; UserInfo
  remains a separate optional operation. This is the reviewed dependency candidate.
- [Intents SDK](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk)
  explicitly has no testnet. Sandbox receipts cannot qualify a live route.
- [OutLayer VRF](https://app.outlayer.ai/docs/vrf) binds output to request ID,
  sender and seed; request ID/sender are injected by its worker. Same-request
  retrieval, latency and terminal races still need an actual service experiment.
  New execution IDs cannot be used as recovery attempts.

No provider credentials, public signing, funded requests or new registrations
were used. The sole tracker records blocked gates and independent local work.

## Scope confirmed with the owner

- [ADR-0001](adr/0001-application-and-authentication.md) accepts Next.js + TypeScript
  on Node.js and openid-client for Telegram/Google login with PostgreSQL-backed
  sessions. Authentication selection is resolved; live verification is normal
  implementation work. Docker Compose local setup and Railway hosting are accepted; see PRD section 16.5.
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
  indefinitely. The accepted fixed multiplier is 1.25× from day five onward.
- Research and scoping are authorized. Application implementation, live spending,
  deployments, and repository visibility changes are not authorized by this review.

## Stack baseline and remaining selections

| Responsibility | PRD baseline | Evidence and remaining choice |
| --- | --- | --- |
| Website | TypeScript + React, responsive web, optional PWA | React recommends starting with a framework. Next.js App Router is accepted in ADR-0001; Railway is selected; operational settings remain open. [React](https://react.dev/learn/creating-a-react-app) |
| API and execution | TypeScript API and durable workers | Keep financial retries independent of an open browser or HTTP request. Node.js is accepted; Railway is selected; job library and scheduler remain open. This is a product architecture proposal. |
| Private records | PostgreSQL | Database constraints can enforce record validity; cross-row rules need appropriate uniqueness, foreign keys, and transaction design rather than arbitrary CHECK expressions. ORM, migration tooling, provider, and job locking remain open. [PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html) |
| Money rules | Rust + near-sdk, one bounded NEAR contract | SDK supports asynchronous calls and fungible-token standards. Showup's escrow and recovery rules still need implementation and tests. [SDK](https://github.com/near/near-sdk-rs) |
| Cross-chain delivery | NEAR Intents / 1Click | Quotes and status tracking exist; secure registration attribution and outbound destination enforcement remain G1 proof obligations. [1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) |
| Identity | Telegram and Google login plus wallet ownership proof | Both document OpenID Connect (OIDC), a standard for verified sign-in. openid-client with PostgreSQL-backed sessions is accepted in ADR-0001; provider login does not prove wallet control. [Telegram](https://core.telegram.org/bots/telegram-login), [Google](https://developers.google.com/identity/openid-connect/openid-connect) |
| Messaging | One ordinary Telegram bot, no Mini App | Telegram explicitly exempts regular bots without a Mini App from its Mini App blockchain restrictions. Preserve the ordinary website wallet flow. [Guidelines](https://core.telegram.org/bots/blockchain-guidelines) |
| Draw proof | OutLayer candidate | Documented signatures and verification support investigation; they do not establish that Showup can enforce one request per authorized round, prevent discretionary rerolls, or survive withholding. [OutLayer](https://app.outlayer.ai/docs/vrf) |

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
| Managed hosting | Accepted: Railway for web, separate worker, and PostgreSQL | Docker Compose supports local setup of the same application. Region, sizing, billing cap, backups, restore checks, and shutdown/recovery plan remain unapproved. No service is provisioned. |
| Authentication | Accepted: openid-client for provider login and PostgreSQL-backed application sessions | Source-verified protocol fit for Telegram without email or UserInfo, and Google OIDC. Session lifecycle and explicit account linking require application work; live proof remains outstanding. See the authentication resolution below. |
| EVM wallets | Wagmi + viem for Rabby on Base and Ethereum | Candidate typed EVM connection layer. Verify Rabby discovery, chain switching, signatures, transactions, and mobile returns. [Wagmi](https://wagmi.sh/react/getting-started) |
| Solana wallet | Phantom through its documented provider or Solana Wallet Adapter | Choose the smallest supported integration after desktop/mobile signature and funding checks. A connector does not supply a cross-chain escrow adapter. [Phantom](https://docs.phantom.com/solana/integrating-phantom) |
| NEAR wallet | Evaluate HOT Connect before defaulting to Wallet Selector | The Wallet Selector repository recommends exploring HOT Connect while remaining supported during transition. Confirm the owner's wallet, testnet support, signature format, mobile return, and integration boundaries before adopting. [NEAR Wallet Selector](https://github.com/near/wallet-selector) |
| Transfers and draw | Keep 1Click and OutLayer as gated candidates | Preserve G1 and G2 below. A documented feature or preferred ecosystem integration is not a passed experiment. |

The proposed runtime shape is: browser and ordinary bot to the Next.js API;
API to private PostgreSQL records and job queue; a separate worker to external
providers and the NEAR contract. The worker submits authorized actions and
reconciles results; it cannot choose beneficiaries or alter finalized amounts.

Railway operations still need a domain, region, baseline budget and spending cap,
secret storage, log redaction, alerts, database restore policy, and environment
separation. Accepted hosting is not authorization to purchase or deploy. Contract
liabilities and accepted prizes must remain recoverable beyond service shutdown.

RPC/indexing provider, error monitoring vendor, exact NEAR wallet,
and test-library versions remain open. Compare existing accounts and
requirements before introducing another paid service. Package selection needs
compatible stable versions and supply-chain checks before installation.

## Framework compatibility review

Reviewed October 29, 2026 against current official documentation and the source
noted below. This is documentation/source verification, not an installed build,
wallet session, transaction test, or security audit. No package versions are
approved. Railway was subsequently selected; this historical compatibility review does not establish deployed behavior.

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
availability, cost, immutable key policy for funded events, per-round request binding,
and timeout behavior remain untested. The accepted explicit-decline redraw policy now requires one bound request per authorized round, with frozen weights minus decliners. The owner accepted three same-request attempts within two minutes (provisional 0/15/45-second schedule), followed by return of unallocated draw assets if no valid result exists. Actual recovery support, timing, and atomic timeout handling remain unproven; see the consolidated recommendation below.

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
| 1 | Custody and proof protocol | Review the cross-chain signing recommendation below; prove NFT custody evidence, restricted signing, finality and accept/return race safety. Validate same-request randomness recovery and the provisional two-minute schedule. |
| 2 | Libraries and providers | Review the consolidated package below. Choose the actual NEAR wallet, RPC providers, monitoring destination, compatible stable versions and audited dependency pins. |
| 3 | Funding and operations | Supply public development-wallet addresses; approve total/per-transfer/attempt caps and supported reduced amounts, pre-funded event assignment, attendee funding, Railway region/domain/resources/budget, backups and shutdown recovery. No spending is authorized. |
| 4 | Build approval | Estimate against the selected custody design, verify devices/staff/schedule, and approve the implementation plan. Both attendance modes and all four required networks remain in scope. |


Accepted economic, attendance, claim, and exposure rules are authoritative in
[the PRD](prd.md), not new discussion items. In particular: 5 USDC default / 2.50
public minimum with bounded restricted-mainnet exceptions; attendee deposit and
withdrawal fees; zero platform fee; 40/60 hybrid plus equal-only/draw-only;
optional quizzes; 1.25× streak; three-minute fresh host code words; no manual
attendance overrides; optional single NFT with contributor-paid custody/delivery;
one accepted winner and explicit-decline redraws inside one 30-day deadline.

A separate visitor testnet environment and simulation mode are excluded. Real
mainnet Intents is part of the restricted hosted experience. Engineering testnets
remain useful, with faucet instructions only for selected engineering networks.
Exact costs are not established until supported routes are quoted and tested.


The daily model assumes enough eligible events exist for a five-day run. That
is a supply and product-validation question, not a reason to change the confirmed
daily streak behavior. Repeated boosts alone are not evidence of retention.

Use [the plan](plan.md) for the proposed sequence and task status. No alternate
task tracker or implementation approval is created by this evidence document.

## Consolidated technical recommendation

Prepared October 31, 2026. This is a proposal for the next scope review, not a
second task tracker or implementation authorization. Accepted product policies
remain in the PRD. Review the package together instead of selecting each minor
library through a separate interview.

### Application and integrations

| Area | Recommendation | Rationale and remaining check |
| --- | --- | --- |
| Application/runtime | Retain accepted Next.js App Router, TypeScript, Node.js, openid-client, PostgreSQL sessions, Docker Compose and Railway | No reason to reopen the documented identity/framework decision. Separate web and durable worker processes. |
| Database/jobs | Drizzle with node-postgres; pg-boss in the worker | Both fit Node/PostgreSQL. Use explicit transactions and a durable outbox so a committed money-state change cannot lose its job. Queue retries do not guarantee exactly-once external transactions. Verify the chosen transactional integration. |
| UI | shadcn/ui, with accessible native states for closed registration, fees, and pending transfers | Keep the existing React direction; verify mobile wallet return and audio separately. |
| Wallet adapters | Wagmi/viem for Rabby on EVM; Phantom's documented provider for Solana; NEAR Connect for the chosen NEAR wallet | Keep injected/direct paths; mobile support and supported signing methods must be tested. The actual NEAR wallet still needs owner selection. |
| USDC routes | 1Click as the NEAR Intents adapter | Implement G1 as a complete real deposit/escrow/refund loop, starting with Base, then qualifying every other required route. This ordering does not remove network requirements. |
| Randomness | Retain OutLayer as the first candidate, not a verified dependency | Same-request recovery must satisfy the accepted retry policy; do not substitute new request IDs. |
| Testing | Propose Vitest for TypeScript rules, Playwright for browser flows, and Rust/NEAR sandbox tests for escrow | Add provider integration and actual-device checks. Tool versions and fixtures follow implementation approval; these choices are recommendations, not installed tooling. |
| Operations | One Railway web service, one worker, PostgreSQL; structured redacted logs and explicit health checks | Select an existing monitoring destination/provider where possible. Add durable alerts for stalled funds and failed jobs, not only HTTP uptime. Resource sizing and monthly spend remain unmeasured. |

[Drizzle documents Node PostgreSQL drivers](https://orm.drizzle.team/docs/get-started-postgresql).
Its current examples use release-candidate tags; do not copy these as approved
stable dependencies. [pg-boss](https://github.com/timgit/pg-boss) documents a
PostgreSQL-backed Node job queue. Exact versions, advisory checks, release-age
policy, and lockfiles must be settled before installation. Other adapter evidence
is linked in the framework review above. Context7 lookup did not find OutLayer;
its unrelated results were not used. For pg-boss it returned a secondary index;
the upstream project was consulted instead.

### NFT standards and custody proposal

Recommend a narrow, explicit asset allowlist, preserving all four networks:

| Network | Proposed first supported format | Boundary |
| --- | --- | --- |
| NEAR | NEP-171 NFT | Validate the pinned collection and exact token, receiver callback and return semantics. |
| Base and Ethereum | ERC-721 | Share reviewed EVM transfer code, but deploy/configure and test each chain separately. ERC-1155 and unusual transfer behavior need separate approval. |
| Solana | Metaplex Core asset, with a reviewed plugin/authority allowlist | Current Metaplex guidance prefers Core for new projects. This does not include every existing Solana NFT. Legacy Token Metadata, programmable NFTs and compressed variants are not implicitly supported. |

NEAR's [NEP-171 standard](https://github.com/near/NEPs/blob/master/neps/nep-0171.md)
defines its NFT interface. [OpenZeppelin ERC-721](https://docs.openzeppelin.com/contracts/5.x/api/token/erc721)
documents transfer and receiver interfaces, not Showup escrow policy.
[Metaplex Token Metadata](https://www.metaplex.com/docs/smart-contracts/token-metadata)
is supported but labeled legacy for new projects; [Core](https://www.metaplex.com/docs/smart-contracts/core)
is its recommended new format. Inspect collection and asset authorities/plugins
that could block, freeze, delegate, or move a prize after escrow. If the intended
contributor has a different NFT format, change the explicit scope before building.

The detailed protocol and accepted observation trust boundary are in
[ADR-0002](adr/0002-nft-custody.md). Contract-enforced release and the bounded attested observation model are
owner-approved for the restricted release; implementation remains unapproved.

**Preferred architecture to investigate:** NEAR contract-governed Chain Signatures
for per-event external custody addresses, with native NEAR NFT custody in the
Showup contract. Chain Signatures lets a NEAR contract request signatures for
external-chain transactions. The official [overview](https://docs.near.org/chain-abstraction/chain-signatures)
lists EVM and Solana examples, but explicitly distinguishes outbound signing
from verification of external state. This is a documented avenue, not a proven
Showup custody implementation.

The contract must construct or fully validate the allowed transfer payload from
the accepted prize state. Never expose unrestricted signing of caller-supplied
hashes or transaction bytes. Bind network, custody derivation, asset, recipient,
round, nonce/blockhash, fee bounds and operation; permit release or return only
once. The broadcaster may submit authorized transactions but cannot select new
recipients. Evaluate MPC availability, key derivation and upgrade controls.

**Unresolved security boundary:** proving external NFT deposit/finality and
reconciling external transfers back into the NEAR ledger. An RPC observation is
not automatically a trustless contract proof. The observer policy in ADR-0002
is accepted for the restricted release; its technical enforcement remains unverified. Showup must not publish a prize based only on an unchecked worker
claim or refund an asset whose delivery remains uncertain.

Alternative: native EVM escrow contracts and a Solana custody program receiving
verifiable NEAR release decisions. This adds deployment and cross-chain message
verification work; it does not eliminate the proof boundary. Reject a general
operator wallet as the silent shortcut. Approve a custody design only after its
source-level design review, then prove it in the approved implementation.

### Draw recovery finding and recommended mechanics

[OutLayer VRF documentation](https://app.outlayer.ai/docs/vrf) binds its signature
to request ID, sender and user seed. Under its documented deterministic signing
algorithm, the same key and complete input produce the same output; a new request
ID changes the input even when the seed is unchanged. Signature verification alone
does not attest the service's execution, availability or original-request provenance.
It documents NEAR signature verification. It does not establish that Showup can
recover a failed execution under the original ID within two minutes.

Use one persisted round/request record. Attempt recovery at the accepted
provisional offsets, checking existing result/transaction state before retrying.
A queued retry must never create a new randomness execution or reset the deadline.
The contract accepts either the matching verified result or the timeout return,
never both; stale results cannot revive a returned round. A pending chain
transaction requires reconciliation, not a second transfer. Measure submission,
provider processing, callback and finality separately. If the provider cannot
meet the policy, return with evidence and a revised proposal before funded use.

### Financial and access implementation details

- Store gross entitlement, authorized fee cap, actual fee, and net delivery as
  separate integer amounts. Fee cap is bound to payout/destination and enforced
  server-side and at the money-authority boundary; no silent cap expansion.
- Recommend aggregate delivery of already-available USDC liabilities to the same
  authorized destination where this reduces fees, without waiting for a 30-day
  prize claim. Never charge the full fee twice to constituent allocations.
  Exact aggregation behavior remains a technical proposal.
- Distinguish invitation redemption, temporary seat reservation, deposit
  authorization expiry, and registration cutoff. Their clocks are not interchangeable.
- Use atomic capacity allocation and a single durable funding-attempt record.
  An expired reservation can enroll only under the accepted late-arrival-of-funds
  rules. Automatic return still requires route evidence and safe retries.
- Closed event pages remain accessible within their existing privacy boundary;
  expired invitation tokens never regain enrollment authority. Disabled buttons
  supplement server/contract enforcement.
- Mainnet spending needs an owner-approved aggregate cap covering gas, routing,
  contract storage, signing/randomness services, NFT transfers and retries, plus
  separate limits for refundable principal and sponsor rewards. Holding tiny
  balances is useful containment, not a substitute for authorization checks.

### Implemented manifest boundary

The [mainnet](../manifests/mainnet.v2.json) and
[engineering](../manifests/engineering.v1.json) manifests now record exact network
and token identities. [Verification](verification.md#protocol-manifest-checkpoint-november-2)
records primary-source checks and negative admission tests. Every route remains
disabled pending attributable escrow/authorized-return evidence; metadata is not
proof of custody. Missing signer hashes, observer keys/provider pairs and NFT
allowlists remain explicit gaps.

### Approval boundary

Recommended next review: approve the application-library package and narrow NFT
formats together; implement and verify the accepted custody trust model after build authorization.
Then supply wallet public addresses and approve actual quoted spending/hosting
caps. No secret values are needed for scoping. Provider accounts, installations,
contracts, deployments, transactions and public access remain unauthorized.
