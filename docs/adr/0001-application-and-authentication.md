# ADR-0001: Application framework and authentication

Status: Accepted by the owner on October 29, 2026. Local framework foundation
implemented November 2; authentication is not implemented.

## Decision

Use Next.js App Router with TypeScript on Node.js. Use openid-client for Telegram
and Google OpenID Connect login, with revocable application sessions stored in
PostgreSQL and explicit account linking.

## Context

Showup needs documented wallet integrations and Telegram login without email.
The compatibility review established a viable protocol path. Building and testing
login, sessions, and linking is normal implementation work, not an unresolved
stack decision. Hosting was subsequently settled as Railway with Docker Compose
local setup in [PRD section 16.5](../prd.md#165-runtime-and-exposure). Exact versions
are pinned in the manifest and [setup](../setup.md). Bounded foundation/draft
implementation is approved; authentication remains outside that authorization.

## Invariants

- Telegram-only users can sign in without email or Google.
- Identify accounts by verified issuer and subject, never display name.
- Verify token signatures and claims; use state, nonce, and S256 PKCE.
- Do not request Telegram UserInfo or fabricate an email address.
- Sessions are revocable, expire, rotate on login, and use secure HttpOnly cookies.
- Linking requires explicit action from a signed-in user and proof of the second
  identity. Never merge accounts automatically by email or username.
- Wallet ownership and payment authorization remain separate from social login.

## Consequences

Next.js reduces custom wallet UI wiring relative to SvelteKit. openid-client
provides the login protocol, not a complete auth suite: session lifecycle,
linking, rate limits, and authorization are application implementation duties.
No additional hosted identity provider is required by this architecture.

## Rejected alternatives

- SvelteKit is viable but requires more custom wallet UI wiring. No performance
  benchmark drove this decision.
- Better Auth's proposed generic OAuth setup requires email and does not meet
  standalone Telegram login requirements without changing the identity model.
- The inspected Auth.js default discovery path assumes a UserInfo endpoint.
  Prefer the standard openid-client path over compatibility patches.

## File references

- [Technical evidence and authentication design](../technical-scope.md#authentication-resolution-documented-protocol-fit)
- [Product requirements](../prd.md)
- [SCOPE-01 and proposed build sequence](../plan.md)

## Verification / guardrails

Source and documentation review used openid-client v6.8.8. No package is installed
or live login verified. Implementation must test both provider journeys, session
restoration/revocation, invalid and replayed callbacks, explicit linking,
conflicting ownership, and phone redirects as described in the technical scope.
Run dependency and security checks when selecting and implementing exact versions.
