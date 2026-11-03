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

The latest November 2 audit has **0 high/critical and 19 moderate development advisories**,
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
a separate keyed index. Preserve both application keys while records exist;
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

## Financial-consent preparation

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

After rebuilding, **Account → Review your financial authorizations** shows only that
account's prepared or approved terms. Approval is separate from escrow confirmation;
the page and read-only `/api/commitments` never report a funded seat. History uses
private cursors and remains readable after re-sign-in. Backend contract preparation
loads the original encrypted proof and acceptance time; callers cannot replace them.
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
backend-only in `showup_test`; no QR display/camera interface or real attendance
is enabled. Pending candidates remain unconfirmed. Own export includes QR/scan
metadata without capabilities or another attendee's identity; deletion clears
ephemeral QR/scans and preserves necessary original financial candidates.

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
context. They freeze accepted candidates, not complete transport/intake health.
No live outage watermark or submission/recovery worker is enabled. Their packets
retain `sourceQualified: false` and `liveSubmissionAllowed: false`; qualified
settlement/purge, camera and device work remain incomplete.

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

The prototype accepts only its sandbox authorization domain. Direct funding checks
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
The app publication/account setup is an engineering fixture. The script neither
loads `.env.auth` nor signs on a public network; it refuses any other database URL.
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
