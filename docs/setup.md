# Local setup

This is an unfinished local application. Google/Telegram authentication is
verified in the development pilot; event publication, live funding and transfers
remain unavailable. Approved scope is
the larger halfway implementation goal; see [the plan](plan.md). Implemented and
verified capabilities are recorded separately from that authorization.

## Runtime and dependencies

Docker will supply Node 24.22.2 LTS and npm 11.19.1. Native development also
accepts Node 26 LTS; no global runtime change is needed. `.nvmrc` records the
canonical version. [Node's release policy](https://nodejs.org/en/about/previous-releases)
defines supported LTS lines.

The manifest pins all direct versions. Next.js 16.4.3, React 19.3.1,
Drizzle 0.45.4, pg 8.23.1 and pg-boss 12.38.0 were selected from registry metadata
on November 2, 2026. TypeScript 6.0.3 fits typescript-eslint's supported range.
ESLint 9.39.5 fits Next's plugins; it is deprecated upstream, so moving to
ESLint 10 waits for those plugins' declared compatibility.

```sh
npm ci --ignore-scripts
npm run supply-chain:check
npm audit --audit-level=high
npm run check
npm run build
```

`npm ci` uses the lockfile. `.npmrc` enforces a seven-day release-age gate,
exact saves and blocked lifecycle scripts. The explicit supply-chain check
also validates every locked package's age, registry URL and SHA-512 integrity.
It requires the public npm registry. esbuild, fsevents and unrs-resolver
lifecycle scripts remain blocked; platform packages supply the needed binaries.
No scaffold or downloaded package runner is used.

The November 3 QR dependency audit has **0 high/critical and 17 moderate development package entries**,
all originating in minimatch's glob denial-of-service issue
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
These tooling paths parse repository lint patterns, not event input. The runtime
graph (`npm audit --omit=dev`) has zero advisories. Do not use force-fix to
downgrade unrelated tools or override major-version contracts blindly.

If the sandbox cannot write the normal package cache, set `npm_config_cache`
to a disposable writable folder for that command. Do not change workstation
permissions to repair a sandbox restriction.

## Checks

The existing Git hooks and imported standards kit stay active. Format/lint
enforcement includes long-line, statement-chain and JSX density rejection probes.
`npm run check` performs formatting, lint, types and unit tests. Database,
worker and browser checks use the disposable resources below.

## Secure local identity setup

Owner checks verify Google/Telegram sign-in and explicit linking through the
approved development tunnel. Separate actual-phone checks remain open. The local
launcher below stays on loopback; the ngrok procedure has its own authorization.
Use only approved test accounts. Application setup sends no external messages.

1. Run `npm run auth:prepare`. It creates ignored `.env.auth` with mode 600,
   fresh separate encryption/index keys, a local development database and empty
   provider fields. It refuses to overwrite an existing file. Do not print or
   copy this file into chat, logs, Git or container images.
2. Open `nano .env.auth`. Fill `SHOWUP_GOOGLE_CLIENT_ID` and
   `SHOWUP_GOOGLE_CLIENT_SECRET`, and/or `SHOWUP_TELEGRAM_CLIENT_ID` and
   `SHOWUP_TELEGRAM_CLIENT_SECRET`, through the provider's interactive setup.
   Keep each key/value on one line. `export NAME=value` is also accepted.
   The runtime parses allowlisted keys as data, rejects malformed lines by number,
   and never executes or expands shell text. Never source the file.
3. Follow the provider registration steps below. Google can use the local callback
   `https://localhost:3443/api/auth/callback/google`. BotFather rejected this pilot's
   localhost URLs; Telegram uses the separately approved exact ngrok address below.
   Other hosting or tunnel addresses remain outside this permission. Telegram uses
   OIDC client credentials, not a bot API token. Request only `openid profile`.
4. Start database/migrations using the normal Compose command, then run
   `npm run dev:secure`. Open `https://localhost:3443/account`. The local launcher
   generates a disposable self-signed certificate; accept its local browser warning
   for testing. No trust-store change is made. Next.js serves HTTPS directly on loopback
   port 3443. Ctrl+C stops it. Stop this development server before the default
   native browser suite, or use the documented container E2E mode.
5. Sign in through an actually configured provider. Refresh restores the account;
   Log out revokes its session. Linking requires the current account session and
   fresh proof of the second identity. Email/username-based merging is absent.
6. For the initial administrator only, copy the account reference shown after
   verified sign-in and run the following command, replacing `ACCOUNT_REFERENCE`.
   It loads the same private configuration parser and works only against the
   designated disposable local database. Bootstrap closes atomically once an
   administrator exists; there is no bootstrap HTTP endpoint.

```sh
node --import tsx scripts/bootstrap-admin.ts ACCOUNT_REFERENCE
```

The anonymous workspace remains separate and cannot be imported into accounts.
Session cookies require HTTPS, are HttpOnly/SameSite=Lax and store opaque tokens;
only hashes reach PostgreSQL. Identity mappings use authenticated encryption and
a separate keyed index. Telegram's verified `profile.id` is retained encrypted
separately from its OIDC `sub` for optional bot identity checks; they are not
interchangeable. Returning login may add a missing profile ID without changing
the account; an established profile binding cannot be replaced. Own export
includes this ID when retained. A legacy record without it remains valid for
sign-in, and restricted deletion recovery collects no new profile data. This
grants no bot-message consent. See [Telegram's claims](https://core.telegram.org/bots/telegram-login#available-scopes).
Preserve both application keys while records exist;
generating replacements cannot recover encrypted identities. These are application
keys, not wallet keys. Isolated fixtures do not prove live login or phone callbacks.

### Provider registration, owner steps

The local private configuration already exists on M4; do not regenerate its
application keys. On November 2 the owner created the Telegram bot and confirmed
both ngrok URLs below persist in BotFather. The owner subsequently verified both
providers, explicit linking and return to the same account through Google or Telegram.

Google, following [Google's OIDC setup](https://developers.google.com/identity/openid-connect/openid-connect):

1. In Google Cloud Console, create/select the Showup project. Configure Google
   Auth Platform branding, choose External audience and add the owner's test email.
2. In Clients, create an OAuth client of type **Web application**. Name it
   `Showup Dev`. For the approved tunnel, register this exact redirect URI:
   `https://liable-pleat-maritime.ngrok-free.dev/api/auth/callback/google`.
3. Set the JavaScript origin to `https://liable-pleat-maritime.ngrok-free.dev`.
   Leave **Use this client for an AI-powered agent** unchecked: this is human sign-in.
   The separate local launcher can instead use the localhost origin/callback above.
   Showup uses the server code flow with `openid profile`; no other Google API
   permissions or service-account key is needed.
4. Enter the client ID and secret in the existing private file using nano,
   under `SHOWUP_GOOGLE_CLIENT_ID` and `SHOWUP_GOOGLE_CLIENT_SECRET`. Copy the
   entire Client ID, including `.apps.googleusercontent.com`. The original secret
   is shown only on creation; if the private copy is lost, generate a replacement
   in Google Cloud rather than trying to retrieve the old value.

Telegram, following [Telegram's OIDC setup](https://core.telegram.org/bots/telegram-login):

1. In Telegram, open the official verified `@BotFather` yourself and create/select
   a Showup development bot. This is an owner action; the agent sends no message.
2. Open BotFather's mini app → your bot → **Login Widget**. Select **Switch to
   OpenID Connect Login** if the legacy domain screen is still shown. Under
   **Trusted Origins**, add `https://liable-pleat-maritime.ngrok-free.dev`.
   Under **Redirect URIs**, add
   `https://liable-pleat-maritime.ngrok-free.dev/api/auth/callback/telegram`.
   Leave and reopen settings to verify they persist. Localhost was rejected;
   do not keep retrying that address.
3. Obtain the OIDC **Client ID** and **Client Secret** from that section. Enter them
   as `SHOWUP_TELEGRAM_CLIENT_ID` and `SHOWUP_TELEGRAM_CLIENT_SECRET` in nano.
   The bot API token is a different credential. Login requests only `openid profile`;
   phone sharing and bot-message access are separate consent, not required login.

For a rejected provider URL, report the nonsecret error rather than inventing an
accepted redirect or switching browser login to HTTP. A new public callback,
tunnel hostname or hosting configuration needs separate authorization.

After saving, restart `npm run dev:secure`, open
<https://localhost:3443/account>, and use the newly enabled provider button.
Successful login visibly shows an account reference. Then test refresh, logout,
sign-in again and explicit second-provider linking. Report only provider names,
registered callback URLs and success/nonsecret error, never credential values,
authorization URLs, callback query strings or tokens. The live gate remains open
until these actual interactions pass.

### Approved ngrok sign-in check

The owner separately authorized this development tunnel and the exact hostname
above on November 2. It makes the app reachable online while running; it is not
an approval for general hosting, spending, funding or production identity readiness.
ngrok is installed separately, with its authtoken in its owner-only local config.

Put the Telegram client ID/secret into the existing `.env.auth` fields through
`nano .env.auth`; storing them in a password manager alone does not configure the
app. Never paste credentials into shell commands, screenshots or chat, and never
source the file. Preserve the application encryption/index keys.

Build the application, then keep the production-mode local server running:

```sh
npm run build
npm run start:tunnel
```

In another terminal in this repository, start the tunnel:

```sh
npm run tunnel
```

The launcher loads the private file without executing it, requires the Telegram
fields and development database, and uses the fixed public HTTPS origin without
rewriting `.env.auth`. The production server listens only on `127.0.0.1:3445`;
the anonymous harness is disabled. The existing secure development server on 3443
is independent. ngrok forwards to this local HTTP upstream; browser requests use
public HTTPS and secure cookies. Local traffic inspection is disabled. Do not
rewrite the Host header: host/origin checks must see the registered domain.

Open <https://liable-pleat-maritime.ngrok-free.dev/account> in one browser.
Continue past ngrok's free-tier notice if shown. Sign in with Telegram, confirm
the provider prompt, then verify an account reference, refresh, logout and sign-in
again. A saved BotFather setting or HTTP 200 alone does not prove login. Do not
share callback URLs containing query strings. If also testing Google through this
launcher, register the same public origin and `/api/auth/callback/google` first.
The owner created the Showup Google project/client and saved both Google fields
privately on November 2. Both fixed issuers now use their advertised
`client_secret_post` method over HTTPS, preserving secret bytes. The owner then
confirmed Google approval/linking; aggregate database checks show both providers
on one account without printing identity values. The owner also verified logout
and Google-only sign-in returning to that exact account. While signed in through
Telegram, choose **Verify and
link Google** to keep the same account; after successful linking, logout and
Google sign-in should restore that exact account reference.

Telegram's approval notification alone does not prove a Showup session. On
November 2 the owner reached `/account?auth=failed` after approval; no account or
session was created. The app terminal now reports only allowlisted callback
stage/error/claim names, never the original error, provider body, codes or tokens.
This includes allowlisted OAuth errors nested in Telegram's HTTP-200 error
responses, which the client library otherwise reports as a missing token field.
The captured live category was `invalid_client`. Telegram now uses its advertised
`client_secret_post` method: credentials stay in the HTTPS token request body,
avoiding the Basic-header re-encoding observed with the saved secret. A strict
signed fixture reproduces the old failure and passes with this method while
retaining signature, issuer/audience, expiry, nonce, state and PKCE checks.
After this change the owner confirmed actual Telegram sign-in, Showup's
"Sign-in confirmed" message and the Log out control on November 2. The owner also
verified refresh, logout and re-sign-in returning to the exact same account.
Google linking and Google-only sign-in after logout returning to the same account
are also confirmed. Separate actual-phone checks remain open.
Use a fresh attempt after a fix; consumed authorization codes cannot be replayed.

Ctrl+C in the ngrok terminal removes public access; Ctrl+C in the app terminal
stops its local production server. Other tunnel domains, HTTP browser origins,
unexpected ports/paths and development-mode use of the public origin are rejected.

## Attendee event entry

After rebuilding, published events have a website entry at `/events/<event-id>`.
Public events show their terms before sign-in; private events require the owner's,
invited attendee's, assigned validator's or existing financial account's access.
Drafts remain private to the host workspace. The page excludes answers, social/
account identifiers and contributor return addresses. Closed pages retain links
to owned authorizations and recovery, with an explicit disabled deposit control.

Sign-in from an event returns to that exact event. Only an event UUID path is
accepted, with no arbitrary origin/query/fragment redirect. Existing pending
invitation review takes priority; after acceptance, choose **Open your invited
event**. Restricted recovery never gains new commitment authority. Real-provider
return to the new page remains an owner walkthrough; registered callback URLs
and existing application keys are unchanged.

When the optional bot is configured, its ordinary event link selects this same
website flow. Starting that link neither creates an account nor subscribes to
messages. A private event's title is not exposed by an anonymous bot welcome.
The event page and bot prompts use the same event-scoped host alias. Financial
approval stays on the website. Funding and actual publication remain disabled
while protocol/route qualification is missing; browser evidence uses explicit
published-state fixtures, not live escrow.

## Optional Telegram connection

**Account → Optional Telegram messages** keeps website participation available.
The bot defaults off. When separately configured, explicitly opt in, create the
five-minute connection link, open the ordinary private bot chat and press Start
with the Telegram identity linked to this Showup account. Return and refresh the
status. Disconnect removes message permission without removing Telegram sign-in.
Account deletion also removes the connection and pending links; own export includes
the connected bot and consent time, excluding link tokens and blind sender indexes.

Migration `027-telegram-connections.sql` adds these records. Activation requires
separate ingress approval and owner configuration of `SHOWUP_TELEGRAM_BOT_ENABLED`,
`SHOWUP_TELEGRAM_BOT_ID`, `SHOWUP_TELEGRAM_BOT_USERNAME` and
`SHOWUP_TELEGRAM_WEBHOOK_SECRET`. The configured webhook is
`/api/telegram/webhook`; no webhook has been registered. Its secret authenticates
incoming updates and is distinct from the OAuth client secret and Bot API token.
Preserve the existing application keys. Event check-in prompts additionally require
the separately approved `SHOWUP_TELEGRAM_MESSAGES_ENABLED` and
`SHOWUP_TELEGRAM_BOT_TOKEN`; the token must belong to the configured bot and is not
the OAuth client secret. Both messaging and bot activation default off. No live
messages, webhook registration or owner configuration changes have been performed.
Actual bot activation, credentials, messages and phone testing remain gated. See Telegram's
[deep-link rules](https://core.telegram.org/bots/features#deep-linking) and
[webhook authentication](https://core.telegram.org/bots/api#setwebhook).

For an owned, approved digital-event authorization, **Send this event's check-in
prompt to Telegram** uses the same funded-state admission gate as website check-in.
Unqualified routes cannot send a prompt. A delivered prompt names the event and
binds to that account, consent and attendance cutoff. Reply to its exact message,
or include its short prompt code; ambiguous text never selects the latest event.
Website and bot submissions share five guesses, immutable retry operations and
one candidate. Telegram's message date cannot extend the server receipt window.
Bot authority permits only that attendance reply, never website sessions, wallets
or financial actions. Pending verification remains unconfirmed; informational bot
receipts have no delivery guarantee. All financial approval stays on the website.
Unknown prompt delivery retains the original record instead of sending another
message automatically. Disconnect/deletion removes messaging authority; original
financial/evidence obligations remain. Prompt transport metadata expires seven
days after its deadline, independently of those retained obligations. Enabling
the webhook also requires renewed coverage qualification for that ingress.

## Wallet-control verification

Apply the normal application migrations, including `005-wallet-control.sql`, before
starting a rebuilt app. A private branch push does not update an already running
server. Existing application encryption/index keys must remain unchanged.

After social sign-in, choose **Verify and review your wallets**:

- Base/Ethereum: use a compatible EIP-1193 wallet with personal message signing,
  select the matching mainnet and review the host, address, chain, nonce and expiry.
  Contract wallets are not verified in this pilot.
- Solana: use a compatible injected wallet such as Phantom and sign the displayed
  message. Private keys remain in the wallet.
- NEAR: enter the mainnet account, continue to MyNearWallet, then choose **Finish
  NEAR wallet verification** on return. The pilot supports NEP-413 Ed25519 full-access
  keys; current finalized membership must agree at both fixed RPC sources. A
  function-call key does not establish control.

Success adds the wallet to **Saved wallets**. Refresh and sign-in restoration read
the durable own-account records. After a lost acknowledgement, **Retry saving this
proof** resubmits the original operation/signature; **Refresh saved wallets** checks
what actually persisted. A new challenge expires after five minutes. Changing the
account/session, host, chain, address, nonce or signed message cannot reuse it.

This proves wallet control only. Funding still requires separate event/rules,
destination/fee authorization and actual attributable escrow; these routes remain
disabled. Agent browser evidence uses disposable in-memory wallets and test accounts.
The NEAR redirect was inspected without contacting MyNearWallet; actual wallet
approval/return, live NEAR membership and phone behavior remain owner/provider gates.

## Publication requirements

In the host workspace, save a draft and choose **Check saved publication requirements**.
The server checks that exact owned revision. Unsaved edits hide the result and require
a save; stale revisions require reload. Validation alone does not qualify funding,
escrow, execution reserves, sponsor rewards, NFT custody, draw recovery or staff
eligibility. The checklist explains those prerequisites; publication stays disabled.

The native disposable integration now prepares one encrypted publication image
from the saved revision and fixed staff roster (`029-event-publication-images.sql`).
Its salted material commitment is included in the contract rules hash; description
corrections remain separate. Prepared terms and exclusions stay frozen while the
original contract outcome is reconciled. The host checklist shows a pending image
when one exists; it cannot enable live publication. Backend observation requires
the exact original profile, rules and contract state. Deletion keeps unresolved
publication credentials under the forward `030-publication-deletion-hold.sql`
constraint. Own export includes scoped metadata, excluding the private image/salt.
See [ADR-0005](adr/0005-publication-material-commitment.md). This integrates native
principal-only sandbox events; prize/reserve qualification and all live routes
remain incomplete.

## Financial-consent preparation

Read-only provider pricing now supports both exact-output entry and exact-input
return quotes between NEAR USDC and each external USDC network. Return results
keep gross principal, quoted net output and minimum net output separate. Signed
amounts and destinations are verified; dry fee details remain unauthenticated.
The [initial funding guide](development-wallets.md#mainnet-preparation-and-initial-funding)
records actual public dry prices and deployment collateral separately. This adds
no browser funding operation, deposit address, signature request, reservation or
route qualification; actual authorization/escrow/return gates stay closed.

The sandbox contract's read-only `inspect_routing_quote` now reproduces the pinned
SDK's selected-field hash and Ed25519 verification with the fixed provider key.
Its selected-field block is authenticated; it explicitly leaves expected-request,
freshness and funding checks false. Dry fee fields remain excluded; wet quote
deadlines can mask the echoed request deadline, which is reported as unauthenticated.
`contracts:check` includes an independent Node replay of its sandbox output.

The local `reserve_routed` path now stores the original credential authorization,
source-wallet financial signature and authenticated quote before a short
`routed_commitment` token message can fund its registration. Frozen rules pin the
provider sender, quote key and four asset identities. Actual NEAR source control
is checked at reservation; EVM/Solana signatures allow a NEAR relayer without
requiring an attendee NEAR wallet. Request and response deadlines are checked
separately. [ADR-0006](adr/0006-routed-registration-binding.md) records the binding.
Disposable token tests exercise all four source-wallet families, cancellation and
original NEAR payout, plus short/excess/duplicate/late receipt debt and substitution
failures. Independent Node replay matches the application wire and signature
formats. External refund liabilities remain unpaid when delivery is unqualified.
The policy is sandbox-only: it does not qualify actual source-chain routing,
external payout, provider custody or mainnet application funding. Ordinary browser
funding remains gated; no owner-runtime or public deployment is changed.

The optional sandbox return policy now freezes an observer profile and at most
three attempts per principal/refund liability. `route_return` checks the existing
debt, original destination, authenticated exact-input quote, minimum net and remaining
shared fee budget, then sends only that gross amount to its fixed NEAR deposit
address. A successful token callback records **submitted**, preserving debt and
blocking another send. Signed destination witnesses are bound to that image and
unique transfer; conflicts or over-cap outcomes pause routing. A provider refund
requires actual escrow cash coverage before reusing principal, with bounded balance
rechecks and a version check against intervening money operations. Return history
keeps fees and net delivery distinct from gross settled entitlement. The tests use
synthetic witnesses and actual disposable cash; public monetary observation,
provider attribution and application reconciliation remain unqualified. See
[ADR-0006](adr/0006-routed-registration-binding.md#bounded-return-prototype).

`compareTokenTransferSources` reads only registered, same-network/environment RPC
candidates and compares actual pinned-USDC transfer facts at finalized inclusion.
NEAR requires the original transaction signer as its RPC lookup key, which may
differ from the token sender. Receipt-array ordering cannot change its event ID:
the ordinal packs byte-sorted receipt position, log position and event-data position
into three eight-bit fields. ERC-20 uses the log index; SPL uses outer-instruction
position in the high sixteen bits and zero for top-level or inner position plus
one in the low bits. Token-account owner/mint metadata and net credit are checked
for SPL, including resolved v0 accounts; failed CPIs and unsupported token programs
cannot supply payment evidence. Self-transfers produce zero delivery credit.
The [public read receipt](evidence/token-transfer-reads-2026-11-04.json) reuses actual
NEAR deposit/cancellation-return and Base Sepolia self-transfer transactions;
sanitized regression inputs omit actions and financial envelopes. Other EVM/SPL
variants remain offline fixtures. Matching data does not qualify RPC independence,
asset authorities, provider-route causality or a funding route; no receipt is
signed and no seat/debt is mutated. Source formats:
[NEAR events](https://docs.near.org/smart-contracts/anatomy/events),
[ERC-20](https://eips.ethereum.org/EIPS/eip-20),
[Solana metadata](https://solana.com/docs/rpc/http/gettransaction) and
[SPL ABI](https://github.com/solana-program/token/blob/f62a0b05415e64b0af0823864bbb2df2a49f5d49/interface/src/instruction.rs).

From an available event, choose **Review wallets and commitment destinations**.
Select independently verified source, source-refund and principal-payout wallets;
source refunds must use the source network. **Review destinations and fee availability**
rechecks the account's wallet ownership, current published rules, eligibility and
registration close on the server. Changing a selection clears the displayed review.
The page displays all three destinations and explicitly unavailable quote/fee/net
amounts. It creates no consent, signature, reservation, provider request or payment
instruction. Until an escrow recipient and attributable funding/return route are
qualified, financial approval remains disabled. This is a completed local review
step, not a qualified quote or funding integration.

**Verify another wallet for this event** retains the event context through wallet
verification. The NEAR callback binds that exact local event parameter into the
original NEP-413 signature and strips the returned proof from the address bar;
**Return to this event's commitment review** restores the review page. This does
not register the wallet for an event or authorize funds. Actual mobile wallet
return and real routes remain owner/device gates.

Wallet choices now survive a full-document return in the same tab. The verification
link retains only opaque wallet IDs in `sessionStorage`, scoped by a server-derived
private account/event/rules reference. Restoring is limited to 30 minutes and the
account's currently verified wallets, including the same-network refund constraint.
Editing or starting a fresh review clears this temporary record; closing the tab
also discards it. It contains no address, login token, quote, signature or approval.
Restoration does not restore a previous review result: the server must check the
current wallets/rules again. There is no database migration or change to app keys.

Internal financial-consent storage also requires `006-commitment-consent.sql` via
the normal migration command. It adds a new table; it does not rewrite accounts,
wallets or application keys. The consent service currently has no HTTP endpoint or
wallet-return page. Its preparation seam binds verified own-wallet records to
published event terms and explicit integer fee limits; accepting its signature
stores `user_authorized`, with no reservation, enrollment or provider call.
Quote hashes supplied to this internal seam are not authenticated provider evidence.
The future funding adapter must qualify the quote, source and attributable escrow
before it can issue instructions or book capacity. Browser control proofs cannot
substitute for this separate financial signature. Unverified routes stay disabled.

`007-settlement-reconciliation.sql` and `008-settlement-observation-completeness.sql`
add the internal encrypted observation journal. Older blocks cannot overwrite newer
state, identical refreshes reuse the snapshot, and RPC outages preserve pending debt
while marking it unavailable. Finalized forks, code changes and regressing counters
latch a pause; later agreement cannot silently clear it. These are restricted backend
seams with no HTTP endpoint, worker polling activation, own-account binding or live
funding capability. A journal entry is not a financial authorization or route approval.

`009-event-participant-credentials.sql` preserves one encrypted opaque credential per
account/event, including an existing consent's first credential. New registrations
and nonces do not create another event identity. This does not prove one human per account.

The internal contract-wire builder validates the exact original signature and maps
UUID credentials into the prototype's 32-byte fields. Its default profile remains
mainnet-bound; an explicitly supplied sandbox profile is required for disposable token
proofs, whose message says **DISPOSABLE SANDBOX TOKENS ONLY**. That profile is not a
web flag or funding override. Native sandbox events with `wallet_consent_origin`
verify the full NEP-413 message, nonce, destinations, fee cap, deadlines and actual
transaction source key, then use the existing escrow/capacity/refund engine. Legacy
construction fixtures omit this policy and remain unqualified for live funding.
EVM/Solana wire mapping is tested, but their actual escrow/return paths remain gated.
This checkpoint adds no consent endpoint, wallet-return page, broadcaster or deployment.

The explicit engineering financial profile now uses the existing engineering
manifest hash, `showup.engineering.authorization.v1`, NEAR `testnet` chain identity
and **ENGINEERING TEST TOKENS ONLY** warning. The constructor accepts that pinned
profile alongside the existing sandbox profile; it still rejects a mainnet domain.
Neither a web request nor an environment toggle creates the engineering profile or
qualifies funding. Both profile variants now pass actual local reservation,
funding, release and return with independent Node signature/wire verification.
This is engineering-domain execution in the disposable local chain, not a public
deployment or actual testnet transfer.

`compareEngineeringSettlementState` reads only the two fixed testnet candidates
in `rpc-candidates.v2.json`; v1 remains intact. It requires the engineering profile,
checks chain identity, finalized common block, frozen code and exact settlement
state. The mainnet reader rejects engineering inputs. The sources follow current
[NEAR provider documentation](https://docs.near.org/api/rpc/providers): NEAR archival
testnet and FastNEAR testnet. One actual read-only header comparison matched;
operator independence, asset/deployment qualification and funded round trips remain
unverified. At that read-only checkpoint no public signing, key loading,
deployment or spending occurred.

Prepare a concrete **unsigned** native experiment with
`node --import tsx scripts/native-engineering-plan.ts` after the pinned WASM build.
This reads only public testnet facts from both fixed sources, including token
precision/code, balances and protocol storage price at one finalized block.
It writes a private temporary JSON plan with the exact WASM hash, two proposed
child accounts, 5 test-USDC principal, a 20-test-NEAR ceiling and the fixed
create → fund → release → return sequence. It loads no wallet/application keys
and has no execution option. The observed preparation requires about 14.2525
test NEAR; the project wallet held about 10 and zero test USDC. Test-token funding
and explicit public-signing/deployment approval remain prerequisites. The
separate operator driver, `scripts/native-engineering-run.ts`, accepts only an
explicitly approved plan path/hash with `execute-approved-plan`,
`resume-approved-plan` or `recover-approved-plan`. Its fixed testnet endpoint,
manifest, token, artifact and destination checks cannot be changed by environment
variables. Fresh public preflight must confirm funding and the frozen costs/code
before execution. The original approved plan remains usable after owner funding.

The driver parses the existing project testnet wallet as data, verifies its
derived FullAccess key against both sources and generates separate disposable
child/credential/evidence keys. It never reads `.env.auth` or rewrites existing
wallet/application keys. Private retained state lives at
`contracts/.cache/native-engineering/<operationId>.json`, mode 0600. The fixed
fourteen-step path allocates exactly 5 test USDC, signs the normal financial
consent, observes actual escrow, releases and withdraws the original liability,
then returns that principal to the project wallet. Each signed transaction is
saved and synced before one HTTP attempt. Unknown acknowledgments query the
original hash/sender; they never refresh the nonce and repeat the transfer.

Recovery first reconciles every possibly submitted image, closes new funding,
and permits at most four additional images for original-event cancellation or
deadline-based fail-neutral resolution, original liabilities and the same test
principal return. Uncertain images or pending callbacks stop recovery. Preserve
the private state and any crash lock for operator reconciliation; do not delete
or regenerate keys while funds are unresolved. The approximately 12 test NEAR
in escrow and 0.25 in the attendee remain in those disposable accounts, including
storage collateral; no automatic account/key deletion is performed. This is part
of the proposed 20-test-NEAR ceiling, separate from the returned 5-test-USDC principal.

Local verification covers independent pinned native decoding/signatures and
durable original-hash recovery. The approved November 3 public trial deployed and
published successfully, but its reservation encountered insufficient prepaid gas,
then expired after the owner-approved gas amendment. Recovery returned the original
5 test USDC from the unfunded attendee and cancelled the event. Both sources agree
on zero escrow funds/debt and the original root token balance. This is **not** a
successful funded escrow/release round trip. [Public receipt](evidence/native-testnet-2750f947-d374-424d-9b4c-328379227ada.json).
Future plans/calls use 200 Tgas. Newly prepared reservation/funding images carry
their original authorization expiry; a new broadcast needs at least 30 seconds
remaining. Already submitted images still reconcile after expiry. Recovery also
closes an unfunded published event, preserving the original keys/images and all
principal. A fresh public operation needs a new concrete approval; use the retained
deployment when preparing it rather than assuming another deployment is funded.
The read-only preparation option is:

```sh
node --import tsx scripts/native-engineering-plan.ts --reuse-retained
```

Reuse pins the prior public receipt, deployed code and finalized initialization
keys, existing token storage and zero unresolved funds. It proposes a fresh event
and authorization, a 1-test-NEAR transfer from root to the retained attendee, and
the same 5-test-USDC principal round trip at 200 Tgas, under the 20-test-NEAR total
ceiling. It skips creation/deployment/initialization/storage steps. Only public
facts are read during preparation. The approved executor references the recovered
operation's private keys without copying or generating them; a persistent parent
claim serializes use of those accounts until the new operation settles or recovers.
An interrupted operation must resume/recover under its own approved hash. Another
operation cannot replace that claim, and stale crash locks still need review.
An explicit RPC `Retry-After` stops immediate transport retries. The operator can
wait up to ten minutes and repeat the failed read phase once, with a fresh block
comparison; signing and submission are outside this retry boundary. A repeated or
longer cooldown stops with the original state intact. Signer reads precede new
short-lived action authority, and the first-broadcast expiry guard also covers
release images. Retained expired authority is never renewed automatically.
The approved reuse trial subsequently proved an actual 5-test-USDC escrow deposit
and full return through event cancellation and original-principal withdrawal.
The recovery driver passed final two-source checks and released its account claims.
Normal release was not exercised in this public trial: its prepared authority expired during source
stops before any transaction image was saved. An additional combined snapshot
hit rate limiting; the receipt reuses the passing driver checks and exact hashes,
without claiming a new combined snapshot or final native balance measurement.
[Reuse receipt](evidence/native-testnet-8529d901-add9-4b0a-9dab-ae9d43142fee.json).
This tool cannot activate application funding, qualify an asset/route, prove the
other three networks or establish full milestone-4 completion.

After rebuilding, **Account → Review your financial authorizations** shows only that
account's prepared or approved terms. Approval is separate from escrow confirmation;
the page and read-only `/api/commitments` never report a funded seat. History uses
private cursors and remains readable after re-sign-in. Backend contract preparation
loads the original encrypted proof and acceptance time; callers cannot replace them.
Own history itemizes the recorded maximum source input and exact asset, native gas
cap, USDC routing/delivery caps, zero platform fee and minimum net payout. Quote,
reservation-limit and funding-authorization expiries are separate, displayed in the
event timezone and the browser's timezone when different. The browser timezone is
used only for display. These are original limits; actual charges remain unreconciled.
The event page, registration review and release deadline use the same two-zone
display, with seconds and the original UTC instant in each `time` element. Digital
and personal-QR check-in show opening, on-time grace and final cutoff; staff scan
controls and the host's code closing time also show event and browser timezones.
This extends display wiring under PRD §7 without changing any server window,
eligibility rule or closed funding/attendance gate. The browser timezone is never
transmitted or saved.
There is still no HTTP operation for signing, paying or submitting a contract packet.
Browser checks generate disposable per-run fixture keys, shared only with isolated
test workers; they never load the operator's credential configuration.

`010-commitment-settlement-links.sql` adds the internal consent-to-watch binding.
Apply it through normal migrations before a rebuilt app reads financial history.
Binding requires the original stored approval and exact native authorization; it
does not qualify a source or send a transaction. Own records show waiting, unavailable
or paused source checks. Conflicts preserve the recorded obligations; unqualified
observations never become confirmed escrow or funded seats. No watch-creation or
refresh endpoint is exposed to browsers.

Own history now also shows the existing principal-recovery journal's queued,
unknown-acknowledgement, pending, unavailable, conflict or observed status and its
original request reference. Fail-neutral recovery remains distinct from no-show
classification. Release/cancellation/abort observations keep the original approved
destinations; none is a qualified payment receipt. The release section shows the
strict start-minus-ten-minute deadline and remains disabled until its route is
qualified. The data page names the actual financial, published-event or pending
publication hold. Sandbox observations never clear those holds.

Native application user-release requests now bind explicit account confirmation
to the original approved consent, exact funded registration and immutable contract
action (`031-commitment-release-requests.sql`). Active and deletion-requested accounts
retain recovery authority for their own obligation. The server enforces the strict
start-minus-ten-minute boundary and a bounded action expiry; retry returns the same
encrypted image/nonce. Fresh requests require new explicit confirmation and a
current funded source observation. No destination or amount can be changed by a
release request. Own history/export include scoped references, excluding the private
image. The HTTP route accepts no source assertion and remains unavailable while
the funding/return route is unqualified. Qualified settlement-dependent purge remains
incomplete.

The shared attendance packet builder accepts only explicit sandbox context and
validated funded contract state. It binds the original event, participant, rules,
proof class, server receipt time, nonce and bounded expiry; its result stays
`pending_contract`, with live submission disabled. It neither establishes a valid
code/staff proof nor signs or confirms attendance. `contracts:check` independently
replays actual sandbox signatures and principal returns for both proof classes.
Online-code, staff QR, durable evidence processing and actual-phone journeys remain
incomplete. A pure receipt builder or sandbox token cannot qualify live attendance.

### Host attendance codes

Apply migration `013-attendance-code-windows.sql` before rebuilding these controls.
For a published online event, its owning active host can choose **Open fresh code
window**, then reveal the displayed phrase verbally. A window lasts three minutes,
clipped at the fixed final cutoff. Case/spacing/compatibility variants of any earlier
phrase in that event cannot create a fresh window. **Show current code** restores
the current phrase and closing time after a refresh or another-tab rotation.
A failed acknowledgment retries the original operation; it does not rotate twice.

Only the owning host can read phrases. They are encrypted at rest and absent from
URLs, audit payloads, exports and ordinary operation receipts; freshness uses a keyed
index. Export includes own window metadata. Published obligations preserve these
records after a deletion request while code management is disabled. Their eventual
settlement-dependent seven-day purge is still part of incomplete I5 integration.
This adds host controls, not attendee acceptance, funded seats or live publication.
Agent browser verification uses explicitly published engineering fixtures in the
disposable database. Do not create such records in the owner's development account.

### Event validators

Migration `014-event-validators.sql` adds event-scoped assignments and preserves
the existing host/event invitation scopes. After saving an in-person draft, choose
**Event validators → Invite event validator**. The private link shows the event,
planned time and exact grant; its recipient must sign in and explicitly accept.
It grants no global host, wallet or payment authority. Unused links expire at the
earlier of 15 days or planned start, and cannot assign staff after publication.
No message is sent automatically.

**Refresh validator assignments** shows event aliases, not provider IDs or wallets.
Assignments/removals advance the saved revision; reconnect storage and reopen the
event before editing its rules or checking publication. An account that already
approved a commitment cannot become a validator; an assigned validator cannot
prepare or approve an attendee commitment. Before publication, the host/admin can
remove an assignment. An old redeemed link cannot restore a removed assignment;
a fresh invitation and consent are required. Publication fixes the roster.

Own exports include assignment metadata. Deleting a draft clears its invitations,
assignments and event credentials. Deleting a validator's account removes draft
authority and off-chain identity; published events retain only minimal fixed
exclusion metadata/opaque credentials, with no continuing validator authority.
Other unresolved financial/published-host obligations retain their existing holds.
No owner account or development database was changed during agent checks.

This implements assignment and app eligibility, not live contract publication,
personal QR issuance/scanning, presence confirmation or accepted attendance.
Contract exclusion/publication integration and settlement-dependent purge remain
unqualified/incomplete. The browser freeze check uses an explicit engineering
publication fixture, never a product publication or funded seat.

## Attendance attempt boundary

Migration `015-attendance-attempts.sql` adds per-account/code-window attempt
counters and encrypted immutable pending candidates bound to the original
event/account/financial approval. Failed guesses commit; five attempts exhaust
one active window. Normalized retries with the original operation do not consume
another attempt. Server arrival determines the window and on-time/late class;
browser timestamps and funding/source flags are rejected.

`POST /api/attendance/check-in` remains unavailable until attributable escrow and
attendance evidence are qualified. There is no enabled attendee code-entry flow.
Positive checks use explicit backend-only sandbox observations against
`showup_test` and localhost; they cannot enable the development tunnel or a live
route. Own records label these candidates **Attendance not confirmed**. No receipt
is signed/submitted, no seat or attendance is confirmed, and no wallet or identity
appears in that status. Export includes only one's own candidate summary; pending
deletion preserves the original candidate and clears failed-guess counters.
Qualified settlement clearance and material purge remain incomplete.

### Online attendee code entry

After rebuilding, an active account's approved, published online authorization
shows **Check in with the event code** in **Account → Financial authorizations**.
The displayed window uses owned event timing, the original event timezone and
the browser timezone when different.
An unknown response retains the same phrase/operation for explicit retry; no
browser timestamp or eligibility flag is sent. Only a bound pending receipt can
show a recorded request, and it never confirms attendance or a deposit.
Page-hide clears pending input and ignores delayed replies; restored pages reload.
Restricted deletion recovery keeps financial records without a new entry form.
Malformed event timing hides the preview while preserving the financial approval.

Agent checks use the actual closed HTTP boundary plus explicit backend-fixture
packets for positive UI/replay cases. Public funding/evidence stays unavailable;
these browser fixtures do not qualify a real route. Mobile 390-pixel captures,
keyboard submission and cleanup handlers are checked; actual-phone BFCache,
wallet return and audio continuity still need the separate device walkthrough.
The async cleanup follows [React's guidance](https://react.dev/learn/synchronizing-with-effects).
Changed-boundary checks cover active-account visibility, owned timing/ID swaps,
the authenticated and rate-limited POST guard, pending-only responses and type-only
server imports. No endpoint, dependency or live funding source is added.

### Physical QR protocol

Migration `016-attendance-qr.sql` adds encrypted personal QR payloads and private
scan handles. Payloads contain an opaque credential, event ID, nonce and expiry,
with no wallet or social identity. A QR lasts at most 60 seconds, clipped at the
final cutoff; replacement invalidates its old scans. Published hosts/assigned
validators must have a pre-publication credential on the observed exclusion
roster. Scanning reveals an event alias and requires separate explicit presence
confirmation from that exact signed-in validator session. Confirmation time
determines the pending candidate's on-time/late class. No manual lookup or
attendance override is provided.

`POST /api/attendance/qr` accepts only the closed issue/scan/confirm actions and
stays unavailable without qualified evidence. Positive engineering checks run
in `showup_test`; positive browser packets are explicit backend fixtures. The
personal display and staff camera below are implemented; real attendance remains
unqualified. Pending candidates remain unconfirmed. Own export includes QR/scan
metadata without capabilities or another attendee's identity; deletion clears
ephemeral QR/scans and preserves necessary original financial candidates.

### Personal QR display

After rebuilding, an active account's approved, published physical authorization
shows **Show your personal QR to staff** in **Account → Financial authorizations**.
Request the QR when staff are ready. The displayed capability stays in memory and
canvas pixels only; no URL, storage, download, third-party image or identity is
used. The canvas clears at expiry, page hide, tab hiding and unmount. Restored
pages reload. Unknown responses preserve the operation for explicit retry; a
verified expired acknowledgement ends that operation without displaying it.
A displayed QR never confirms attendance, funding or a booked seat.

The exact local codec pins are `qrcode-generator@2.0.4` and `qr-scanner@1.4.2`,
with blocked lifecycle scripts and no new high/critical or runtime advisories.
[Encoder API](https://kazuhikoarase.github.io/qrcode-generator/js/) and
[scanner source](https://github.com/nimiq/qr-scanner/tree/v1.4.2) describe local
encoding/decoding. The server and browser share the bounded opaque-payload parser.
Changed-boundary checks cover foreign/confirmed-looking replies, same-operation
replay, expiry, capability clearing, restricted-account exclusion and closed
actual HTTP admission. Browser success packets use synthetic backend fixtures;
mobile layout is Chromium emulation, not actual-phone/camera evidence. The owner
app is not rebuilt or changed by these isolated checks.

### Staff QR camera and presence confirmation

After rebuilding, **Account → Staff attendance assignments** lists up to 50
published physical events at a time. Only the published host with the host role,
or a validator assigned before publication, can open an event's controls. Both
need a pre-publication event credential. Foreign event/cursor references, revoked
or late assignments and restricted deletion accounts cannot expose controls.
The page returns minimal event timing/title metadata, not a roster, quiz answers,
wallet, financial approval or raw credential. Discovery does not qualify funding.

Choose **Start camera to scan QR**, allow video, then point it at the attendee's
personal QR. One video-only permission request is made per Start click. Decoding
uses a local worker with at most five scans per second; no frames/audio are sent
to the server. The camera, its canvas and worker stop on a scan, Stop, tab hiding,
page hide/unmount or one minute. Each scanner owns a fresh video element so old
asynchronous decoder cleanup cannot stop a newly started stream. A late permission
response is stopped without attaching it or restarting scanning. No automatic
navigation opens a decoded URL or unrelated QR.

A valid inspection shows only an event alias. Check the separate **physically
present** box and choose **Record presence request** while the QR is valid.
Scanning alone creates no attendance candidate. Unknown scan/confirmation replies
retain their original operation for explicit retry, including an acknowledged
confirmation replay after expiry. Only event/scan-bound pending receipts can
show **Attendance confirmation is still pending**. A QR, scan or click cannot
confirm attendance, escrow or a seat, and there is no manual override.

Agent checks use the actual attendee canvas → synthetic camera → local decoder,
with explicit backend-fixture HTTP packets and original database operation
journals. They cover wrong scan acknowledgements, lost ACKs, separate consent,
ID swaps, closed actual HTTP admission, one-request permission denial, rapid
restart, acquired-stream hiding and timeout, mobile 390-pixel layout and keyboard
labels. The denial and rapid-restart negative controls fail on the prior code.
The build's client chunks contain no private server markers. Changed-boundary
security checks cover active-session/assignment authorization, actor-scoped
parameterized queries, bounded response pages, JSON POST limits/rates and origin
guards, no permissive CORS, escaped input, generic errors and type-only server
imports. No upload, billing, admin override or production debug path is added.
Broader production security and actual camera/device behavior remain unverified;
normal evidence HTTP stays closed. Isolated tests do not rebuild the owner app.

### Known attendance intake

Migrations 023–025 journal authenticated in-window attendance work before the
candidate transaction. Code submissions and QR issue/scan/confirm actions retain
only actor-scoped hashes, action/time and completion metadata. The exact original
mutation receipt can drain interrupted retries after a process kill. Normal
freezing rejects pending work or a latched service failure; later success cannot
clear a known outage. Out-of-window or foreign work cannot establish that latch.
Original candidate/operation reads remain available after freezing.

Own export includes only event/action/time/outcome metadata, without an operation
ID, hash, phrase, QR payload or another actor's record. Completed details retire
after 90 days in batches using the existing maintenance worker; pending records
and event aggregates remain for reconciliation. Account erasure cannot erase an
event's failure aggregate. [ADR-0004](adr/0004-attendance-intake-boundary.md) records
the transaction and recovery invariants.

Actual process-kill checks cover before candidate commit and after durable
candidate/receipt commit but before intake acknowledgement. Same-operation
recovery preserves one candidate and its original ciphertext. The prior journal
fails this regression. A backend decryption failure remains latched after recovery;
actor/timing exclusions, own export and bounded retirement pass PostgreSQL checks.

This is a journal of known received work, **not continuous ingress coverage**.
Requests lost before this boundary and service/network coverage still need an
independent qualified witness. Missing coverage is not proof of a healthy service.
No HTTP field, test flag, source status or accepted-candidate count qualifies a
live normal checkpoint. Actual evidence HTTP and public signing stay disabled.

### Signed intake coverage

Normal checkpoint preparation also requires coverage signed by the frozen evidence
authority for the exact event/profile and known-intake digest. Admission covers
publication through registration close, fixed at event start. Online mode requires
host-code and entry coverage; physical mode requires QR issue, scan and presence
confirmation coverage. Each logical channel includes all enabled ingress for it.
At most 128 intervals/32 KiB may claim coverage: no gaps/overlaps, missing channels,
regressing or unresolved counters, reported failures, future observations or
extended expiry. Counters remain exact through `u64`; one channel cannot hide
known work on another. The signed packet persists with the immutable checkpoint
and is reverified before closing; missing legacy coverage cannot enable signing.

Node/PostgreSQL and independent Rust sandbox fixtures sign **unmeasured claims**
only to exercise validation, restart and contract conformance. A valid signature
is not measurement or producer qualification. A qualified collector, verified
publication/route inventory and deployment evidence remain required; actual
HTTP evidence and public signing stay closed. See [ADR-0004](adr/0004-attendance-intake-boundary.md).

The disposable measurement harness in `scripts/loopback-coverage-proxy.ts` binds
only loopback and requires `showup_test`; it is not part of the owner's tunnel.
Migration 026 stores bounded, hash-chained epochs with database-clock observations,
fixed channel names and HTTP outcomes. Requests are recorded before forwarding;
truncated responses and interrupted work cannot become completed successes. A
missed probe interval stays missing after restart. Closed traces use bounded pages;
an expired abandoned epoch must be fenced before reading. Bodies, cookies, paths,
account identifiers and wallet/social mappings are not retained. These local traces
remain unsigned and unqualified; the narrow route inventory and `/account` probe
do not establish complete ingress, dependency or provider availability.
Run its five database checks with the fixed disposable environment:

```sh
node_modules/.bin/tsx --test tests/integration/coverage-*.test.ts
```

The `coverage-capture` browser-suite check additionally forwards actual host-code
and closed attendee requests through an isolated production app. No live route,
owner migration, application key or signing gateway is enabled by this harness.

### Frozen sandbox attendance evidence

Migration `017-attendance-evidence-barriers.sql` freezes the durable accepted
candidate set after attendance evidence grace. Event locking waits for an admitted
writer to commit; subsequent attempts/new code windows are refused. Original
candidate retries remain history reads. Preparing a checkpoint requires matching
signed receipts and contract observations for every frozen candidate, one bound
event/block/ledger, and normal closing prerequisites. Missing evidence, a source
fork/regression, changed context or unreconciled quiz prevents preparation.

The encrypted manifest/checkpoint survive retries; a 100-entry private manifest
has its own bounded digest, and checkpoint wire preserves the exact Rust `u64`
ledger number. Host exports contain only own aggregate/observation metadata;
restricted deletion recovery preserves necessary journal records. The app bridge
now uses this persisted checkpoint for actual sandbox close/return and verifies
Rust/Node signatures across the full u64 range.

These backend-only functions require localhost, `showup_test` and explicit sandbox
context. They freeze accepted candidates and the known-intake aggregate, not
complete transport/service coverage. No live outage watermark or live
submission/recovery worker is enabled. Their packets retain `sourceQualified: false` and `liveSubmissionAllowed: false`.
Qualified settlement/purge and actual device work remain incomplete.

### Sandbox receipt delivery and recovery

Migrations `018-attendance-delivery.sql` and
`019-attendance-observed-signature.sql` queue existing/new accepted candidates and
require signed evidence for an observed delivery. The explicit sandbox processor
stores the immutable signature before submission, uses bounded worker leases and
checks contract state after an unknown acknowledgment. A replacement worker reuses
the original receipt/nonce. Transport failure remains retryable; invalid source,
fork or authority evidence latches a conflict. Expired unobserved receipts require
reconciliation and cannot produce a normal closing checkpoint.

The same `npm run contracts:app-bridge` command now kills a real delivery process
after actual contract acceptance and restarts it. Its private `result.json` records
the signal, two worker attempts, one signing request, one submission and preserved
signed ciphertext for each mode, followed by closing and full principal return.
Process messaging preserves full-u64 source values. Own export includes only that
account's delivery metadata; restricted deletion recovery retains original obligations.

Gateway construction is explicit and limited to localhost/`showup_test` sandbox
context. Generated fixture encryption material travels over private process IPC;
operator configuration and wallet key files are unused.

Migration `020-attendance-closing-delivery.sql` adds one fixed closing checkpoint
per event. The same command also kills the closing process after actual contract
close; a replacement observes the outcome using its original durable signature,
without another signing request or submission. Deadlines are rechecked after
signing, stale workers cannot overwrite replacement claims and conflicting source
facts latch reconciliation. Host exports contain scoped metadata only and preserve
restricted deletion recovery. Run database and browser suites serially against
the shared disposable database; retention checks count global expiring records.

Changed-boundary review checks explicit test-database/local-origin guards, exact
signature/context/ledger binding, parameterized SQL, host-owned export access,
bounded calls/claims, sanitized errors and server-only signed material. No new
HTTP/admin/upload/CORS surface or dependency is introduced. Broader release security
and live-source qualification remain unverified.

Migration `021-principal-recovery.sql` adds native sandbox principal recovery.
It verifies the original encrypted wallet consent/proof, fixes the contract-owned
principal liability and persists its request before transfer. The gateway accepts
only that liability ID. A pending callback prevents a second transfer; unknown
submission without an observed contract attempt stays unresolved even as blocks
advance. A settled failed callback permits the next attempt at the same liability.
Source forks/regressions latch conflict, and completed replay checks the original
encrypted paid observation. Scoped own export and restricted deletion recovery
preserve the request and original financial proof. The bridge now kills/restarts
the principal process after actual payment and checks one withdrawal per mode.

Each receipt, closing and principal worker now saves its latest validated source
observation under the current claim before another external call. Later reads and
fresh processes reject older heights/times, same-height forks and regressing
ledger/accounting/liability facts. These watermarks survive a signer/source failure
before submission; they record observed source state, not confirmed payment or a
complete intake-health signal.

Migration `022-principal-fail-neutral.sql` preserves prior withdrawal attribution
and adds an immutable abort image. An explicitly supplied sandbox capability may
call only `fail_neutral` for the frozen event at or after its verified end + 35
minutes. No host outage reason or local clock can advance it. Abort and withdrawal
use separate claims; unknown responses preserve both images and source state.
Own exports include the last fixed method, excluding the private request images.

The bridge runs normal attendance and unreconciled-evidence cases for each mode.
In the latter, an accepted but expired/undelivered candidate prevents a complete
checkpoint. The actual contract rejects early abort, then refunds through one
permitted abort and one withdrawal after the deadline. Killed processes recover
both effects with original ciphertext intact. These cases exercise native
principal; broader sponsor/NFT abort checks remain separate contract evidence.
This does not establish complete live intake-health coverage.

No live signing gateway, complete intake/outage monitor or runtime transfer daemon
is enabled. Dropped-transaction qualification still needs the planned source/witness
integration; an unknown request cannot clear debt.
Camera/phone checks, real routes and qualified settlement/purge remain incomplete.

## Private account export

After rebuilding, choose **Account → Your data and export → Download your data as JSON**.
The attachment contains that account's linked identity IDs, wallet addresses, original
financial approvals/own observations, authored events and answers, invitation/access
metadata and audit records. It excludes session/capability tokens, OAuth material,
blind indexes, ephemeral challenges and other accounts. Keep the downloaded file private.
Exports are limited to three per account per hour; cross-site requests and account-ID
filters are rejected. On-chain records cannot be erased.

Apply `011-account-deletion-requests.sql` through normal migrations before rebuilding
the deletion controls. **Request account deletion** requires typing `DELETE` and
acknowledging the on-chain/recovery limits. It removes unneeded records and revokes
old sessions. With no approved financial or published-event obligations, off-chain
identity is deleted; completion has an authenticated 15-minute receipt. Otherwise,
original proofs, event credentials and necessary records remain; the same linked
provider restores restricted export/history access, with new activity/linking disabled.
No browser payment flag, expiry or unqualified observation can clear that hold.
Clearance of qualified settled obligations remains incomplete.
Agent erasure checks use fictional accounts in `showup_test`, never the owner's
linked development account. A branch push neither migrates nor restarts that app.

Deletion confirmation expires after five minutes and is bound to the account,
exact session and operation that opened it. Switching accounts, signing in again
or using an old confirmation cannot delete the replacement account. **Reload deletion
confirmation** shows the current account reference and clears the typed acknowledgment.

### Private receipt retention

Migration `012-private-receipt-retention.sql` enables bounded worker maintenance.
Independent wallet-control challenges and copied control receipts expire seven days
after the challenge deadline. Other transport receipt payloads, audit entries and
completed deletion receipts expire after 90 days. Minimal operation/request barriers
remain so an old retry cannot repeat an effect; expired replies return 410.
Original financial approvals, watch obligations and pending deletion holds remain.
Event-bound attendance/quiz material needs qualified settlement before its separate
seven-day purge; that integration remains incomplete.

For the private development app, apply migrations through the non-executing private
configuration parser, then run the native worker in another terminal:

```sh
npm run db:migrate:private
npm run worker:private
```

These commands require the existing owner-only `.env.auth`, its original encryption
key and a loopback development database. They neither source the file nor create keys.
The migration child receives no encryption key; the worker receives no social-provider
or identity-index credentials. A missing/wrong key preserves unreadable legacy material
and reports a generic maintenance failure. Do not regenerate keys to resolve it.
The worker sweeps at startup and once per minute, at most 100 records per table per
transaction. The ordinary Compose worker cannot classify recent legacy encrypted
control receipts without this private configuration. Both workers can run concurrently.
Agent verification uses only disposable keys/database records; these operator commands
have not migrated or started maintenance against the owner's linked account.

## V1 escrow build

The V1 target is `contracts/showup-v1`; the larger V2 prototype remains in
`contracts/showup`. Using the prepared Docker toolchain below:

```sh
sh scripts/contracts.sh v1-wasm
sh scripts/contracts.sh v1-lint
sh scripts/contracts.sh test v1_
```

The artifact is `contracts/.cache/target/wasm32-unknown-unknown/release/showup_v1.wasm`.
The V1-only release strips symbols; the V2 build profile is unchanged. The normal
`contracts:check` also builds/lints V1 and runs its tests. No new registry packages.

The local operator binds verified wallets/attendance and confirms actual NFT custody;
the contract enforces the configured USDC sender/amount, funded seats, immutable
beneficiaries, no host share of forfeitures, settlement and failed-delivery retries.
Attributable `deposit:<registration>` receipts from the bound sender that arrive
late, after closure, when full, twice, or for the wrong amount are retained in
`recovery:<registration>`. Anyone can relay `withdraw` for that claim; payment goes
only to the attendee's immutable NEAR payout account. The payout account must have
USDC storage registration. Failed delivery preserves the claim, and credits arriving
during withdrawal remain available separately. Unknown references and wrong senders
are rejected; validate the reference/sender before requesting an Intents route.

V1 uses one NEAR payout account per attendee, a 64-seat bound, $1–100 deposits,
and host-funded optional USDC/NFT prizes. NFT transaction construction/signature
verification is tested against independent Ethers vectors and a disposable MPC ABI
mock; actual mainnet custody/release remains V1-7. Existing key/upgrade authority is
retained for this local pilot. This is not a production security audit.

Deploy and call `new` in one transaction signed by the contract account's retained
key. The constructor accepts only a self call. No mainnet deployment executor has
run yet. After a failed signing callback, the operator can call
`retry_nft_signature({event})` with one yoctoNEAR, up to three total attempts.
Retries use the original payload/nonce/fees/recipient, and cannot replace a pending
or signed request. A valid original signature remains reconcilable after the limit;
if all attempts fail without a signature, explicit operator recovery is still needed.
These state-layout changes precede the first V1 deployment; an upgrade from an older
deployed layout would require migration.

`scripts/v1-mainnet.ts` is the local owner operator for this fixed deployment and
one 1-USDC cancel/refund test. It pins the artifact, accounts, token, amounts and
step order, checks both public RPCs, and retains each signed image before its only
submission. Default calls are read-only; `--execute` submits the selected new step.
Existing submitted images only reconcile their original hash. Operator receipts
stay in ignored `contracts/.cache/v1-mainnet`; the existing owner key stays outside
the repository. The manual smoke event uses the contract's controlled host account
and the controller as attendee/payout; no no-show or prize outcome is exercised.

```sh
node --import tsx scripts/v1-mainnet.ts status
node --import tsx scripts/v1-mainnet.ts create
```

The ordered steps are `create`, `fund`, `deploy`, `storage`, `event`, `publish`,
`register`, `deposit`, `cancel`, `withdraw`. Mainnet authority and actual fees are
recorded in the plan; this operator has no HTTP endpoint.

## Local contract sandbox

Requires Docker and the accepted Node runtime. No workstation Rust upgrade, wallet
file, provider credential or public deployment is involved. From the repository:

```sh
npm run contracts:prepare
npm run contracts:check
```

Preparation builds the digest-pinned Rust 1.93 container, verifies the nearcore
2.13.4 archive/binary checksums in the engineering manifest and fetches locked
Cargo sources. The check reviews registry/checksum/release-age/OSV metadata before
running Rust formatting, warning-free Clippy, WASM build and actual sandbox tests,
then independently replaying the draw proof, typed custody images, signed observer
and recovery witnesses, and the signing ABI traces/transactions. EVM reconstruction
uses the frozen Ethers dependency. Run
`npm ci --ignore-scripts` first on a clean clone as described above.
Public metadata requests have bounded bodies/retries and a three-minute review
deadline. Metadata cache freshness is limited to six hours; advisories are queried
on every check. [Advisory policy](../contracts/advisory-policy.json) records two
exact fresh security backports and one test-only maintenance notice; no general
advisory or age bypass exists.

Builds/tests run with networking disabled, read-only contract sources, dropped
capabilities, the invoking UID/GID, bounded CPU/memory/processes and only a project
cache mounted writable. CPU requests use available daemon capacity, capped at four.
They create disposable nodes/accounts and synthetic NEP-141 tokens. `.env.auth`,
personal wallets and host credential directories are never mounted. The sandbox
uses long test epochs for clock jumps; published economic windows are unchanged.
Current native-M4 evidence is ARM64; the CI job independently exercises AMD64.
The Trixie runtime supplies the GLIBC needed by the pinned sandbox binary.

The V2 prototype accepts only its pinned non-production authorization domains. Direct funding checks
the actual token sender, signed source/refund/payout destinations, event/rules,
participant/wallet uniqueness, capacity and authorization expiry. Only actual token
receipt creates a funded sandbox seat. Principal liabilities outlive failed
transfers; one pending attempt prevents duplicate sends. Contract-only attendance
tests exercise signed evidence, not a working online-code or QR interface.

### Application-to-contract sandbox check

With the disposable `test-db` running, use the fixed test environment:

```sh
export SHOWUP_ENV=test
export DATABASE_URL=postgresql://showup@127.0.0.1:55433/showup_test
npm run contracts:app-bridge
```

The command builds pinned offline WASM and runs a Node/PostgreSQL peer alongside
an explicit Rust sandbox test. Original app financial consent is signed by the
generated sandbox wallet and actually funds escrow. A normalized host-code attempt
or a scoped validator invitation/QR scan/explicit confirmation persists the exact
candidate then accepted by the contract; both modes pay all principal back.
It also exercises one positive user-release journey: explicit account confirmation
prepares the original action, the actual contract releases the funded seat, and the
existing recovery engine withdraws all principal to the original destination.
For focused release work, use `npm run contracts:app-bridge -- --release-only`;
the default CI command retains all existing attendance/outage cases. This adds no
new kill/restart variant.
Account identities remain disposable fixtures. Event creation uses the normal
draft service and staff invitations; application publication is now reconciled
from the actual sandbox contract against its frozen image rather than a raw
published-state SQL update. This does not qualify a live source or full admission
coverage. The script neither loads `.env.auth` nor signs on a public network;
it refuses any other database URL.
Private phase frames/results live in ignored `contracts/.cache/app-bridge/`.
The ordinary contract suite leaves this peer-dependent test ignored; CI executes
it separately with its test database. No worker completeness, browser QR/camera,
real provider route or phone behavior is established by this check.
First-round proof tests freeze one snapshot/key/version/request/deadline and enforce
same-request recovery/timeout; they do not execute OutLayer or allocate draw assets.
Typed-custody tests prescribe a fixture beneficiary, lock an exclusive intent and
compare constructed bytes independently; they do not request MPC signatures or
prove actual NFT ownership/delivery.
The signing adapter additionally exercises a disposable local provider with the
pinned current `payload_v2` interface. It binds the returned public key to the
frozen custody address/path, verifies ECDSA/Ed25519 signatures, retains exact signed
transactions and permits one provider request per image. A failed/oversized reply
requires reconciliation of that original signature; it cannot authorize a new
request. No broadcaster or live route is enabled. The mock proves this boundary,
not actual MPC root derivation, live service behavior or deployed code authority.
Native custody tests additionally transfer a synthetic NFT, require its receipt
before publication and verify immutable retry/return ownership. Draft cancellation
and hard-grace recovery return prototype holdings. Rules commitments are recomputed
from normalized typed terms and deployment context. These are fresh local deployments;
no production upgrade, collection approval or real winner/fee-reserve flow is implied.

Settlement-state verification reads event/registration/liability/accounting/token
views at one block hash, verifies both code hashes and the complete rules and
authorization, and checks capacity and conservation. `contracts:check` additionally
replays nine actual sandbox states with `scripts/check-settlement-state.ts`, including
a failed refund and its successful retry. Public comparison uses the two fixed NEAR
sources and rejects sandbox or wrong-manifest profiles before HTTP. It has no
published mainnet deployment/profile, HTTP endpoint or funding activation. Agreement
does not qualify source independence, deployed authority, G1 or a real funding route.

The optional `node --import tsx scripts/probe-rpc-candidates.ts` command only compares
public mainnet network identities and finalized headers. It cannot sign/broadcast,
query a wallet or qualify an asset/route. The versioned candidate list and retained
limits are in [verification](verification.md#p5-read-only-source-comparison-checkpoint-november-2).
External source funding/delivery remains rejected and app publication remains
disabled. [Evidence and limits](verification.md#local-contract-checkpoint-november-2).

## Start and stop

For the saved-draft interface, use the opt-in development workspace:

```sh
docker compose --profile harness up --build -d --wait web worker harness
```

Open <http://127.0.0.1:3101/workbench>. Use fictional event details only; no login,
wallet, fee quote, funding or publication is implemented. The same browser can
reopen its saved drafts for 24 hours. The ordinary build at port 3100 is a
nonpersistent rules preview; production refuses the development API and page.
See the [walkthrough and persistence limits](verification.md).

```sh
docker compose restart harness worker
docker compose --profile harness stop
docker compose --profile harness up -d --wait web worker harness
```

Docker Desktop is the only prerequisite for the container application. Run from
the repository root:

```sh
docker compose up --build -d --wait web worker
```

Open <http://127.0.0.1:3100>. Health at `/api/health` requires the database and
completed application migrations, not just a listening HTTP server.

```sh
docker compose restart web worker
docker compose stop
docker compose up -d --wait web worker
```

`stop` retains containers and development data; `down` removes project containers
and network but retains the named development volume. Test data is in tmpfs and
is discarded when the test container is removed. No command here removes the
development volume. Do not use `down --volumes` unless deliberately erasing it.

PostgreSQL 17.11 and Node are pinned by image digest. Services use a dedicated
bridge; published ports are **127.0.0.1 only**: web 3100, dev DB 55432, test DB 55433. No remote services or credentials are configured. Trust authentication is
limited to disposable local data and this project network/loopback; this Compose
file must never be deployed or populated with personal records. Docker Desktop
did not publish ports for an internal network during verification, so this uses
a bridge with verified loopback bindings. No wallet/provider code can spend money.

## Database, worker and browser checks

Native checks additionally require the accepted Node/npm runtime and `npm ci`.
The examples use an explicit **showup_test** database. Integration tests reset
only their disposable outbox/queue test records; never redirect them to real data.

```sh
docker compose --profile checks up -d --wait test-db
export SHOWUP_ENV=test
export DATABASE_URL=postgresql://showup@127.0.0.1:55433/showup_test
npm run db:migrate
npm run test:integration
npm run build
```

Install the pinned Playwright browser with the local binary, then run:

```sh
node_modules/.bin/playwright install chromium
npm run test:e2e
```

To use a temporary browser cache, set `PLAYWRIGHT_BROWSERS_PATH` consistently for
both install and test. Chromium needs permission for macOS process bootstrap;
the Codex filesystem sandbox blocks that and needs its normal reviewed escalation.
CI installs Chromium's Linux system dependencies explicitly. CI is configured,
not remotely executed during this unpublished run.

Run the browser suite against the actual running Compose workspace:

```sh
export SHOWUP_CONTAINER_E2E=1
npm run test:e2e
```

This mode uses fictional data in `showup_dev` and a fresh browser workspace per
test. The default mode instead launches a native development test server on 3103
against `showup_test`. Both modes launch an isolated production build on 3102 to
verify production refusal. CI selects the container mode to cover its origin and
permissions boundaries. Ports 3102 and 3103 must be free when running those tests.

`next-env.d.ts` and both build directories are generated and ignored. Next's
automatic agent-file generation is disabled to preserve the repository front door.

The worker commits an outbox job and dispatch marker together using pg-boss's
transaction adapter. `processed_operations` gives one durable local receipt per
logical operation. Three retries use bounded exponential backoff; expired claims
are checked every second, with a 30-second active-job ceiling. Exhausted jobs go
to `showup-dead`. Inspect counts without payloads:

```sh
docker compose exec worker npm run jobs:status
```

External financial effects require later reconciliation and authorization work.
Queue recovery does not prove exactly-once payment delivery. Applied SQL migrations
are immutable and checksum-checked under an advisory lock; add a forward migration
rather than editing history. Failed DDL rolls back in the integration check.
