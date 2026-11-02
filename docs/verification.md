# Test the local event-draft workspace

The larger halfway goal is active and incomplete. UX-03–07 are implemented;
live identity, funding, publication, contracts and attendance are not yet verified.
The original foundation walkthrough below remains useful historical evidence.

## Invitation and private event checkpoint, November 2

I2 and private I3 management are implemented; funded publication and the full
halfway target remain incomplete. 10 unit and 29 real integration tests pass;
15 distinct Chromium scenarios are covered by the combined container run plus
focused host updates. Format/lint/types, production/Docker builds pass.

The browser exercised actual controls with isolated **preauthenticated fixtures**:
admin issues a host link → invited account explicitly consents/redeems → host
creates, saves, reopens and duplicates an event → another host sees none of its
drafts/answers → an attendee receives no host controls. The published engineering
fixture separately proves disabled material fields and description-only editing
without changing the frozen hash. These do not prove real sign-in or publication.

PostgreSQL proves one winner in invitation races, exact scope, role loss/session
revocation, expiry/revocation, durable replay, independent duplicate records,
stale-write rejection and private IDs. Invitation grants reserve no seat; encrypted
receipts recover the same issued link after transport loss. Redeemed access survives
link expiry and closed registration. No message is sent and no funds move.

Security review traced role checks inside locked transactions, own-account event
queries, ID swaps including admin-without-host access, high-entropy hashed link
capabilities, encrypted recovery/cookies, CSRF/Host checks, shared limits, bounded
JSON, parameterized SQL and error redaction. Correct answers stay in own-account
responses; neither the anonymous workspace cookie nor a role field from the browser
authorizes account data. A second skeptical read checked publication bypass,
concurrent retry and in-flight editing boundaries. Money/contracts/uploads/hosted
security remain outside this implemented-boundary evidence.

Material screenshots are in ignored `.agents/runs/showup-halfway/evidence/`:
`invited-host-draft.png`, `host-actions-mobile.png` and `secure-local.png`.
The actual native HTTPS development page at `https://localhost:3443/invite`
returns 200 and completes client loading with no failed requests. The launcher
uses Next.js native HTTPS with a disposable self-signed certificate, no trust-store
change, and loopback binding. The secure config was generated with empty provider
fields; no existing credential or wallet key was inspected. Stop native development
before the default native browser suite, or use container mode to avoid a second
development server in the same build directory.

New host/admin behavior after secure live-provider setup:

- Admin issues a host invitation → a private copyable link appears; no message is sent.
- Invited account opens it, signs in and explicitly accepts → host access is confirmed for that account.
- Host saves/reopens/duplicates → private revisions persist; the copy is a new unfunded draft with no grants or commitments copied.
- Another account opens host/admin URLs → only its own authorized controls and records appear.
- Host inspects publication → it remains disabled until actual escrow/protocol gates pass.

No persistent fake login or owner-facing test-provider option exists. Fictional
browser accounts are removed after tests. Live registration/callbacks, funded routes,
actual escrow returns, both attendance modes and phone/device behavior remain gates.

## Identity checkpoint, November 2

Implementation: encrypted issuer/subject mappings, browser-bound one-use
state/nonce/S256 PKCE, pinned provider issuers and ID-token signature checking,
explicit linking, opaque revocable Secure/HttpOnly sessions and closed-after-first-use
local admin bootstrap. Live provider registration/login is **not verified**.

Checks: 10 unit, 20 integration and 13 Chromium tests pass; format/lint/types,
production build, frozen install, seven-day supply-chain check and runtime audit
(0 advisories) pass. Full audit has the same 17 moderate development-tool findings.
Signed OIDC tests use a real loopback token/JWKS server and reject signature,
issuer, audience, expiry, nonce, state and PKCE errors. They are provider fixtures.
PostgreSQL covers concurrent signup, linking ownership/session conflicts,
callback replay, shared limits, session expiry/revocation and atomic bootstrap.

Browser evidence uses an explicitly preauthenticated fictional database session
on local HTTPS to exercise actual account refresh/logout controls. It does not
simulate a provider in the application or prove signup. The test checks both real
provider buttons remain disabled without configuration. Screenshot:
`.agents/runs/showup-halfway/evidence/account-fixture.png`.

Security review traced origin/Host/CSRF enforcement, no GET login mutation,
fixed callbacks, callback replay, explicit linking, encrypted private records,
parameterized SQL, no provider-token retention/logging, opaque cookies, revocation,
error redaction, provider disablement and separate anonymous workspace access.
The initial browser failure reproduced `Origin: null` on a plain form under
`no-referrer`; application pages now use `same-origin`, callbacks keep
`no-referrer`, and browser regression proves logout plus hostile-origin rejection.
Request/browser logging is disabled to keep OAuth callback queries out of dev logs.
A skeptical second read found no additional blocker in these implemented surfaces.
Uploads, payments, attendance and hosted ingress remain unimplemented/unreviewed.

Rollback evidence: archived `770424a` startup check passes against the upgraded
disposable test database; migration 003 adds tables without changing existing
ones. Existing draft/restart scenarios remain passing. No production DB is used.
The secure local setup is [documented](setup.md#secure-local-identity-setup).
Owner-controlled provider registrations, actual callbacks/linking and phone return
remain required. Never treat these fixtures as a passed G5 or halfway gate.

## Halfway UX checkpoint, November 2

This checkpoint changes the existing draft journey only. Local evidence: 7 unit,
12 PostgreSQL integration and 11 Chromium tests; format/lint/types, production
and Docker builds pass. Agent-controlled browser inspection at 3101 exercised
save details on desktop and validation at 390px. Screenshots are in ignored
`.agents/runs/showup-halfway/evidence/ux-save-desktop.png` and
`ux-errors-mobile.png`. Tests cover 320/430/640px reflow and keyboard error links.
The duplicate Commitment section/input ID was reproduced in the browser; a new
regression verifies the amount label and linked-error focus after correction.

New since the owner's November 2 walkthrough:

- Search the display timezone → IANA suggestions appear; preview converts and UTC inputs stay fixed.
- Save a valid draft while down the page → a persistent saved-details card names amounts, date, times and timezone, with unpublished/unfunded wording.
- Save invalid fields → a red card names fields/reasons; its links focus controls and preserve entries.
- Save from an older tab → a prominent warning protects the newer save; reload asks before discarding edits, and Cancel keeps them.
- Add a multiple-choice question → separate choices support two through six; removing a selected choice resets the correct answer. Short answer has its own accepted-answer editor.

The network-failure test checks stable operation replay; the new success card is
created only after the server returns a durable receipt. PostgreSQL isolation,
CSRF/origin, bounded JSON, production refusal and race checks remain passing.
No new authenticated, contract, live-provider, mainnet or actual-phone evidence
is claimed. Manual screen-reader/zoom and actual native timezone-menu behavior
on owner devices remain review gates. Existing foundation CI at `4732ee0`
[passed](https://github.com/gueysito/show-up/actions/runs/41486576136);
this checkpoint's CI is checked separately after publication.

## Open it

From the repository root, with Docker Desktop running:

```sh
docker compose --profile harness up --build -d --wait web worker harness
```

Open **<http://127.0.0.1:3101/workbench>**. It is already running at handoff.
No provider account or credential is needed. Use fictional event details only.
Port 3100 serves the nonpersistent rules preview; use **3101/workbench** to save.

```sh
docker compose restart harness worker
docker compose --profile harness stop
docker compose --profile harness up -d --wait web worker harness
```

The first command restarts the editor/worker. The second stops project services;
the third starts them again. These retain stored development drafts.

## A 10–15 minute walkthrough

1. **Create a valid digital draft, 3 minutes.** Enter `Community listening room`,
   session URL `https://x.com/i/spaces/example`, capacity `20`, commitment `5`,
   sponsor budget `100` and Hybrid. Choose any future date, start `18:00 UTC`,
   end `19:00 UTC`, display timezone `UTC`. Leave questions and NFT empty.
   The session link is only a descriptor; it is not fetched or verified.
   Expect the planned split to show `40.00` equal and `60.00` draw, with an
   unfunded-draft label. Click **Validate & save draft** and expect revision 1.

2. **Check the rules, 2 minutes.** Registration closes at 18:00; release is before
   17:50; check-in opens 17:55; on-time grace ends 18:10; final check-in cutoff
   is 18:45; hard close is 19:30. Switch the display timezone to
   `America/Denver` and observe conversion without changing the UTC schedule.
   Try equal-only and draw-only. Forfeitures always belong to the equal pool.
   Read the fee/cancellation preview; these are planned rules, not executed actions.

3. **Try invalid input, 2 minutes.** Set capacity to `101` and commitment to `2.49`.
   Save. Expect linked field errors and keyboard focus on the error summary;
   your entries remain. Follow a capacity error link using Tab and Enter.
   Fix the values to `20` and `5`. A 29-minute or 121-minute duration must fail;
   30 and 120 minutes are valid. Save again for the next revision.

4. **Exercise questions and physical mode, 3 minutes.** Add a question, choose
   Short answer, enter `Which word matters?`, accepted answer `Community`,
   duration `90`, and a planned time inside the event. A question scheduled at
   the event end must fail because its full window would overrun. Add a second
   question to see the two-question limit; remove it if you do not want to fill it.
   Multiple choice needs two to six distinct options and a correct option.
   Switch to In person and fill venue/proof instructions. Its preview changes
   to staff-validated QR; actual QR scanning is outside this implementation.

5. **Try the NFT descriptor, 1 minute.** Enable one planned NFT and choose a
   network. Collection, asset ID and contributor return destination are required.
   Use fictional strings. Equal-only plus an NFT must fail. Remove the NFT to
   save without filling it. No ownership, custody or delivery check is performed.

6. **Reopen and test another tab, 2 minutes.** Refresh and find the saved title
   under **In this browser workspace**, then click it to reload its fields.
   Open the same saved draft in another tab. Save a change in the first tab;
   the second tab's stale save must fail rather than overwrite it. Use
   **Reconnect storage**, then select the refreshed saved revision to continue.

7. **Clear your test workspace, 1 minute.** Click **Clear this local workspace**
   and confirm. Its saved drafts disappear. A separate browser/private window
   has a separate workspace and cannot list these drafts.

## What persists

Saved draft rules, private question configuration and revisions live in the
`showup_dev` database on the named development volume. Container stop/restart
retains them. Refresh restores the saved list; select a draft to restore the form.
Unsaved edits remain only in the page and disappear on refresh.

An HttpOnly browser cookie gives access to its workspace for **24 hours**.
Clearing cookies or using a different browser creates a different workspace.
Expiry ends access; it does not promise automatic data erasure. Clear the workspace
before expiry or erase the disposable volume when finished. Workspace clearing
deletes draft and mutation rows; anonymous operation IDs/worker receipts can remain.
No real host account, wallet history, invitations, funding or attendee records exist.

## Verification and actual results

Checked on M4, November 2, 2026. Docker uses Node 24.22.2/npm 11.19.1 and
PostgreSQL 17.11, pinned by digest. Native checks used Node 26.12.1/npm 11.20.0.
Follow [setup](setup.md) for locked installation and the explicit test database.

```sh
npm run check
docker compose --profile checks up -d --wait test-db
export SHOWUP_ENV=test
export DATABASE_URL=postgresql://showup@127.0.0.1:55433/showup_test
npm run db:migrate
npm run test:integration
npm run build
export SHOWUP_CONTAINER_E2E=1
npm run test:e2e
```

The browser command needs the pinned Chromium installation described in setup.
The local run used `PLAYWRIGHT_BROWSERS_PATH=/tmp/showup-playwright`; set that
variable to reuse this session's temporary browser cache. CI installs its own.

| Check                        | Actual result                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Format, lint, typecheck      | Pass                                                                                                                          |
| Unit tests                   | 7 pass: configuration, timing, USDC conservation, questions/NFT and harness guards                                            |
| PostgreSQL integration       | 12 pass: real transactions, migration/DDL rollback, races, replay, expiry, deletion, SIGKILL recovery and dead-letter retries |
| Chromium browser suite       | 8 pass, including the actual Docker workspace and production refusal                                                          |
| Production and Docker builds | Pass; standalone static assets included                                                                                       |
| Actual Docker walkthrough    | Save, restart, reopen, worker processing and clear pass                                                                       |
| Local HTTP                   | Workspace 200 with `Development workspace`; health 200 with `ready`                                                           |
| Supply chain                 | 472 locked entries checked; lifecycle scripts blocked; 0 high/critical advisories and 0 runtime advisories                    |
| Development advisories       | 17 moderate minimatch tooling findings; details and reachability in setup                                                     |
| Git hooks and standards      | Staged/full checks and readability rejection probes pass                                                                      |

Foundation CI built the Docker harness and exercised it in Chromium successfully
at `4732ee0`; the original local evidence below predates that publication. No Linux-browser or
actual-phone result is inferred from the M4 checks. Screenshot evidence is local
under `.agents/runs/showup-foundation-drafts/evidence/`.

Foundation checkpoints: `eb42d64` (F1), `1eabde0` (F2–F4); draft implementation:
`faa05ff`. A tracked-only archive of `faa05ff` was built in the separate
`showup-repro` Compose project with an empty database and loopback port overrides:
startup, browser interactivity, save/reload/clear and production workspace refusal
all passed. That temporary project and its disposable volume were then removed.
No independent operator or remote CI run is implied. Final receipt status is in
[the plan](plan.md). All existing wallet-documentation commits are preserved.

## Scoped review and limitations

The local review traced production refusal, workspace ID swaps, CSRF/origin/Host
checks, shared rate limiting, bounded JSON input, parameterized database writes,
React text escaping, error redaction, cookie scope, server/client imports and
loopback port bindings. No public admin, payment or upload endpoint exists.
Session URLs and NFT descriptors are not fetched server-side. The harness uses
disposable local trust-authenticated PostgreSQL, not production authentication.

Browser checks include labels, keyboard error navigation, 320/430/640-pixel reflow
and 44-pixel main controls; desktop and phone screenshots were inspected. Manual
screen-reader/200% browser-zoom and actual-device checks remain for owner review.
This was a scoped local review, not an independent security audit or hosted release
approval. A broader audit is recommended before hosted exposure.

## Protocol manifest checkpoint, November 2

The versioned [mainnet manifest](../manifests/mainnet.v1.json) binds NEAR,
Base, Ethereum and Solana to exact chain/genesis identities, native Circle USDC,
decimals, provider asset identifiers, signing domain and finality policy. The
separate [engineering manifest](../manifests/engineering.v1.json) never qualifies
a mainnet route. Empty NFT allowlists and missing provider/observer configuration
keep affected routes disabled.

Primary-source revalidation: [Circle's contract table](https://developers.circle.com/stablecoins/usdc-contract-addresses),
the public [1Click token list](https://1click.chaindefuser.com/v0/tokens),
[1Click's explicit no-testnet statement](https://docs.near-intents.org/integration/distribution-channels/1click-api/sdk),
and [Chain Signatures contracts](https://docs.near.org/chain-abstraction/chain-signatures/implementation).
Public RPC reads at 18:32:02–18:32:06 UTC confirmed Base 8453, Ethereum 1,
NEAR mainnet and the distinct Solana mainnet/devnet genesis hashes. No wallet,
secret, balance or transaction signing was involved. Token-list timestamp and
SHA-256 are in the manifest; they identify the observed response, not an escrow receipt.

`npm run check` passes: formatting, lint, types and 12 unit tests. New hostile
vectors reject wrong environment/revision/chain/token/decimals/provider asset,
cross-EVM token substitution and Solana cluster substitution. Funding admission
always rejects unqualified routes. This is metadata/admission evidence only.
No sandbox, engineering-network, mainnet funding, draw recovery, custody delivery
or phone gate passes from these tests. Signer code hashes, pinned event keys,
independent observer RPC pairs and actual protocol traces remain incomplete.

The previous `ac19b14` private CI passed the full 15-browser-scenario suite,
29 PostgreSQL tests and production/container checks:
[CI receipt](https://github.com/gueysito/show-up/actions/runs/41501064513).

## Local contract checkpoint, November 2

The new settlement-authority prototype is compiled to WASM and executed in actual
nearcore 2.13.4 sandbox nodes. It uses synthetic NEP-141 tokens, fresh per-run
credential/evidence/participant keys and a separately configured local registrar.
This is local sandbox evidence, not Circle USDC, Intents, public engineering-network,
mainnet, social-login, actual-phone or wallet-return evidence.

All 11 sandbox tests pass, including:

- Wrong token/caller, altered authorization fields and source-wallet substitution
  fail. The same source cannot enroll twice through different opaque credentials.
- Short, excess, duplicate, full-capacity and late receipts remain return liabilities;
  only actual full attributable receipt creates a funded seat. The expired-reservation
  last-seat race enrolls exactly one attendee and preserves the other principal.
- Failed NEAR transfer restores unpaid debt; retry reaches the exact authorized
  destination once. Forged callbacks, competing withdrawals and an 8 KiB successful
  return body cannot create a second payment. Integer accounting matches actual balances.
- Both live-code and staff-QR **receipt classes** enforce event/manifest/participant,
  mode and time bindings. Start+10m equality is on-time; +1ms is late. Replayed
  evidence cannot increment attendance. Principal delivery proceeds without a draw.
- Pre-start cancellation and missing complete reconciliation at end+35m return all
  unreleased principal/sponsor funds, with no forfeiture beneficiary or revival.
- The clock guard verifies the pinned sandbox's fast-forward behavior. Long test
  epochs avoid repeated epoch-boundary production; real product timing is unchanged.

Clock/tooling references: pinned nearcore's
[delta-time calculation](https://github.com/near/nearcore/blob/44f7ae6cd7ef08bab604e20a473bf77e35d4c993/chain/client/src/client.rs#L1755)
and [fast-mode delays](https://github.com/near/nearcore/blob/44f7ae6cd7ef08bab604e20a473bf77e35d4c993/nearcore/src/config.rs#L100),
plus the SDK's [custom sandbox configuration](https://github.com/near/near-sandbox-rs/blob/v0.3.16/src/sandbox/mod.rs).

Rust formatting and contract/test Clippy pass with warnings denied. `npm run check`
passes 12 unit tests, formatting, lint and types; production build passes. No database
or user interface behavior changed, so the passing 29 PostgreSQL/15 Chromium evidence
from [private CI at 8543e84](https://github.com/gueysito/show-up/actions/runs/41508449623)
is reused. A separate locked sandbox job is added for this checkpoint; its remote
result is verified after publication. The first cold run at `ab33ecb` passed the
application job but stopped before Cargo: Docker rejected four requested CPUs on
the private runner's two-CPU daemon. The wrapper now requests the smaller of four
and the daemon's reported capacity. Two/fourteen-CPU command probes, the local
pinned runtime and Rust formatting verify this tooling correction; remote cold
compilation remains a separate result. The next cold run passed the CPU guard but
exposed Linux cache ownership: root with all capabilities dropped cannot bypass
the runner-owned bind directory's mode. A disposable Linux permission probe confirms
the failure and the matching-UID success. The wrapper now runs as the invoking
UID/GID, retaining capability/network restrictions. Locked fetch, Clippy and the
clock sandbox check verify that correction locally. See Docker's
[user/capability reference](https://docs.docker.com/engine/containers/run/).

Tested artifact SHA-256:

| Artifact             | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| Escrow WASM          | `2d11e00fadb00a0b88a1618837b715118313dbfda9b4ec096c770a00be855ada` |
| Synthetic token WASM | `c5b2d87835aadfd131b0641224ef862f8040eea0bb60dac29ae61741f7bbd82d` |
| Cargo lockfile       | `3ef58a5a6ec9de6f9600d7867e22107d387ba8b440f8bbd34ffeff059a3cd2ec` |

The locked 380-package graph passes OSV review with one explicitly reviewed test-only
unmaintained YAML package. Exact zstd security backports have dated seven-day-age
exceptions; checksums and advisories remain enforced. The optional unmaintained
allocator is removed. Details/sources are in [advisory policy](../contracts/advisory-policy.json).
Compiler, source fetch and execution are isolated from host credentials; execution
has no outbound networking. Sandbox archives and binaries have independently recorded
checksums in the [engineering manifest](../manifests/engineering.v1.json).

Scoped manual review covered signed-field/domain/manifest binding, separate key roles,
actual token/source checks, immutable terms/destinations/exclusions, capacity/expiry,
private callbacks, competing operations, failure restoration, arithmetic conservation,
bounded reads/loops/resources/retries and secret-free source mounts. The full-access
sandbox keys remain disposable test controls; funded deployment authority removal,
code hashes, gas/storage sizing at full capacity and independent custody review are
still qualification work. No new public HTTP endpoint or upload path is introduced.
Prior web auth/CSRF/CORS/private-data evidence is reused; this is not a new full-app audit.

P2's actual Base→NEAR escrow/authorized-return gate remains unpassed. Native sponsor
funding is the tested prototype subset; external source/delivery paths are rejected.
Google/Telegram live callbacks, P3 same-request service recovery, P4 custody signing,
P5 observers, wallet/commitment/privacy screens and online-code/staff-QR controls
remain incomplete. Attested receipt fixtures do not prove those interfaces or providers.
No rewards allocation, winner claim or later milestone is marked complete.

## Signed pricing adapter checkpoint, November 2

The active [v2 mainnet manifest](../manifests/mainnet.v2.json) adds the provider's
pinned quote key and immutable SDK source revision. V1 remains available for
historical receipts; no network route is enabled.

The read-only 1Click adapter uses native Ed25519 verification and reproduces the
provider's selected-field, stable-JSON/SHA-256/Base58 protocol. A public Base-USDC
to NEAR-USDC dry response verifies against the actual pinned provider key. The
probe used public placeholder destinations, requested no deposit address, made no
wallet signature/transfer and spent no funds. Its sanitized public response is a
[test fixture](../tests/fixtures/one-click-dry-public.json), with no personal wallet
or credential. A subsequent actual adapter request also passed: input `5050741`,
exact principal `5000000`, `fundingAllowed: false`.

Seventeen JS unit tests pass, including signed-field substitution, a disposable-key
wet-quote/deadline collision, stale/future time, whole-principal output, untrusted fee
fields, historical recovery, manifest-only pricing, pre-HTTP funding rejection,
bounded response reads and three-attempt network/429/5xx handling. Format/lint/types
and production build pass. Existing PostgreSQL/browser evidence applies because no
web journey or schema changed; this adds no HTTP ingress or provider configuration.

The SDK signature excludes `appFees`, several routing options and an enclosing
status. Dry quotes also exclude individual fee/time estimates. The adapter exposes
only signed integer amounts and a warning that fee details are unsigned; it cannot
produce fee consent or deposit instructions. Expected request fields are checked
separately, including the deadline that a wet quote's flattened deadline can mask.
Historical status reads remain available after quote expiry, but unsigned status
is only a hint: it cannot enroll, settle debt or initiate a retry. Responses are
bounded to 256 KiB, fixed-origin with redirects rejected, 15 seconds per attempt,
at most three attempts. No unbounded transfer-retry path exists.

Primary references: [signature verification and its exact source revision](https://github.com/defuse-protocol/one-click-sdk-typescript/blob/ae8b24e064785c8cba8081263e03e52fed4de089/src/quote-signature.ts),
[provider verification guide](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature).
Actual escrow attribution, wallet authorization, authenticated fee/destination binding
and an authorized round trip remain P2/G1 gates. No real status route or funding
journey is claimed from the dry response or generated test key.

## Safe cleanup

To remove project containers/network while **keeping stored development drafts**:

```sh
docker compose --profile harness --profile checks down
```

Test database data is temporary and disappears when its container is removed.
No system-wide Docker prune or unrelated-service cleanup is needed.

To **permanently erase every stored Showup development draft**, first run the
`down` command above, then deliberately run:

```sh
docker volume rm showup-local_development-data
```

That optional command deletes stored development data. Normal start/stop/restart
and the first cleanup command do not. The next startup creates an empty database.

## Historical prerequisites, superseded by the active goal

| Task                     | Dependency and owner input                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 network manifest      | Foundation is ready; needs approval to continue the next roadmap package. Public identifiers only; no signing or spending by default.                                                                                  |
| I1 identity/session      | Foundation is ready; implementation approval plus separately authorized Google/Telegram registrations, callback URLs and provider credentials for live proof. No credentials should be pasted into chat.               |
| I2 roles/invitations     | Depends on I1; invitation redemption and host/attendee authorization remain unimplemented.                                                                                                                             |
| Remaining I3 publication | Depends on identities/roles, funding/protocol proofs and immutable rules. NFT publication also requires custody/observer evidence. Real funding, transactions and deployment need separate explicit approval and caps. |

Milestone 4 is untouched. Ethereum's older public finality follow-up remains
unverified in this run; it does not block this local draft workspace.
