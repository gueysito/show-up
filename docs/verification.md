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

## First-round proof checkpoint, November 2

P3 now has a sandbox-only first-round proof boundary. Event terms pin a distinct
draw key, provider/project, version hash and original sender. After complete event
reconciliation, a private fixture call freezes the snapshot and two-minute deadline
**before** request allocation. Binding the original ID cannot reset that deadline.
Recovery returns the same ID/seed/alpha at the provisional 15/45-second offsets,
with at most three attempts including the original submission. It cannot execute
a provider call or create a new request.

The contract checks the exact request/sender/seed, pinned Ed25519 key, signature and
SHA-256 output. Seed derivation includes domain, deployment, manifest, event/rules,
snapshot, first-round/exclusion state and provider version. A verified result or
timeout becomes terminal; late allocation/proof cannot revive it. Repeated matching
results remain idempotent. This boundary does not select a winner, allocate rewards,
return draw assets or implement later decline rounds. Existing principal liabilities
and accounting remain unchanged by proof state.

All **14 actual sandbox tests** pass, including the three new proof scenarios and
the eleven escrow/attendance regressions. An independently serialized Rust seed
matches the on-chain value. Native Node independently verifies the exact proof that
the sandbox accepted; only public generated test data is written to the ignored
contract cache. Eighteen JS unit tests, format/Clippy, lint/types and production build
pass. The unchanged 380-package registry graph passes the release-age/advisory gate;
only the already-locked SHA-256 implementation becomes a direct test dependency.
Tested escrow WASM SHA-256: `cdeda01fdd6b1deacc46618af62625e568b8ec5a5a3f9853e7fc4b6ea98850ac`.
Lock SHA-256: `badab77a3f9663734c666041bdcf9a2ec97f47fd0ae825de51f5d40ac6b7b6ba`.

The earlier CPU/UID fixes pass both jobs in
[private CI at 718f545](https://github.com/gueysito/show-up/actions/runs/41518568017).
The pricing checkpoint also passes both jobs in
[private CI at 1b38c08](https://github.com/gueysito/show-up/actions/runs/41519500727).
P3's new revision has its own remote result after publication. No web
journey/schema changes here; existing browser/database evidence remains applicable.

Scoped review checked immutable key/version/context binding, private freeze/allocation,
bounded ID parsing, failed/unknown submission, replay, exact deadline conditions,
competing terminal calls, unchanged principal accounting and absence of provider
execution/signing APIs. Sandbox full-access accounts are disposable controls; actual
snapshot eligibility, key-removal/deployment authority and original-request allocation
are not proven by them. No funded draw is enabled.

Current [VRF documentation](https://app.outlayer.ai/docs/vrf) describes the signed
alpha/output format; [HTTPS documentation](https://app.outlayer.ai/docs/https-api)
documents polling an existing async call ID. Neither the local fixture nor those
docs establish Showup's actual 0/15/45-second service latency/recovery. No registered
project/version, approved service budget or public signing experiment is configured
for this checkpoint. Native signature verification proves message/key/output
consistency; it does not independently attest deterministic service execution or
availability. Those G2 qualifications remain open without changing the accepted policy.

## Typed custody construction checkpoint, November 2

P4 now proves a local irreversible intent and typed construction boundary for Base,
Ethereum and Solana. A controlled fixture freezes a prescribed beneficiary and
contributor; private contract calls lock either delivery or return after the matching
terminal event/proof state. The opposite decision cannot replace that intent. This
prescribed beneficiary is test input, **not** a real winner or claim implementation.

The contract constructs EIP-1559 zero-value ERC-721 `safeTransferFrom` bytes and their
Keccak signing digest, or a legacy Solana message with exact account roles, Core
`TransferV1`, bounded compute units and explicit zero priority fee. No caller-supplied
hash, calldata, program, path, destination or arbitrary instruction is signed. It
stores the first signing image before returning it; retries preserve that image.
A different nonce/blockhash/fee envelope cannot replace an unresolved image.
No MPC request or broadcaster method is implemented/enabled by these proofs.

Custody derivation is scoped to deployment/environment/network/event/exact asset,
independently of recipient/operation. Delivery and return therefore use the same
custody address. Intent hashes separately bind manifest, rules, payout, operation,
recipient and cap. EVM address casing is canonicalized. Historical manifests remain
available to reconstruct existing intents; active-version changes do not silently
change their chain identities.

All **16 actual sandbox tests**, 21 JS unit tests, production build, formatting and
Clippy/lint/types pass. Independent Node construction matches the exact on-chain
bytes, digests, intent hashes and derivation paths for all three external networks.
Additional focused vectors cover zero/multibyte EVM nonces and hostile extra fields.
The immutable source for Core's program/accounts/discriminator is
[Metaplex at a5c35db](https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/clients/rust/src/generated/instructions/transfer_v1.rs),
with its [program ID](https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/clients/rust/src/generated/programs.rs).
Other primary formats: [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559),
[ERC-721](https://eips.ethereum.org/EIPS/eip-721),
[Solana message layout](https://solana.com/docs/core/transactions/transaction-structure).

Escrow WASM SHA-256: `b8e8b76084afa10788117c8cfb1cdfa33a3eb866ea901ecc4a6db6cf0b58337c`.
Cargo lock SHA-256: `e72ea405fba148d85e351f1388fc24987d1d89f8d864df31c8e9e739bb2a29e7`.
Rust's 380-package graph passes its advisory/age gate; existing `bs58` becomes a
direct dependency. Exact Ethers `6.17.0` and its lockfile pass the seven-day gate;
the 484-entry JS lock passes integrity/registry review. Candidate audit preceded
script-blocked installation. Latest full audit: zero high/critical, 19 moderate
development notices; runtime audit: zero. Contract CI installs the frozen JS lock
with scripts blocked for independent Ethers replay. Both jobs passed at the prior
[P3 revision faf3ce4](https://github.com/gueysito/show-up/actions/runs/41521157807);
this checkpoint's remote result is checked after publication.

Scoped review covered authority, intent races, fixed chain/asset/call/account roles,
canonical addresses/integers, arithmetic bounds, immutable pending envelopes,
bounded encodings and unchanged principal accounting. No HTTP ingress or identity
data path changes; prior auth/private-data/browser/database evidence is reused.
Private full-access fixture calls do not prove production authority removal,
canonical winner selection, MPC derivation/signatures or final custody ownership.

Qualification limits remain material: EVM bounds cover `gas_limit × max_fee_per_gas`,
not demonstrated Base L1/data fees. Solana's fee estimate/blockhash lack finalized
observer evidence; its message itself does not encode a cluster ID. Actual key/path
derivation, NFT/plugin/authority allowlists, native NEAR receipt/delivery, engineering
network execution, dropped/replaced/expired-image reconciliation and two independent
finality sources remain P4/P5 work. No asset or funding route is enabled, no signature
issued, no transfer broadcast, and no production fee guarantee is claimed.

## Native NFT custody and rules commitment checkpoint, November 2

The local P4 prototype now takes an actual synthetic NEP-171 asset through
contributor → escrow → the immutable fixture delivery/return recipient. Publication
requires its exact token/ID receipt. The receiver checks predecessor, original
owner/direct sender, event state and bounded message; rejected deposits roll back
to the original owner through the NFT resolver. No approval/delegate deposit is
accepted. This is a transfer-interface harness, not a complete NFT implementation
or an approved real collection.

Native delivery locks the prescribed fixture beneficiary after the proof boundary;
it does not select a winner or implement acceptance/claims. One pending transfer
prevents competing sends. A failed callback preserves the same liability/recipient
for retry; success remains success even with an oversized return body. Tests inspect
actual token ownership before/after, not just a provider flag or contract status.
Cancelled/aborted events and draw timeout create contributor-return intent without
overriding an existing allocation. Unpublished drafts can now cancel safely; after
hard close plus grace, anyone can trigger fail-neutral recovery of an abandoned
funded draft. A blocked publication cannot trap sponsor/NFT holdings.

Review also found that the prior sandbox checked `rules_hash` as a label. A deliberate
negative baseline confirmed it accepted unrelated hashes. The contract now recomputes
a recursively sorted compact UTF-8 JSON/SHA-256 commitment over every normalized
term plus the format tag, authorization domain, deployment, manifest and settlement
token. The hash field itself is excluded. Independent fixture computation matches;
mutated amounts, schedule, roles, destination, capacity, exclusions, NFT descriptor
and provider policy are rejected specifically by the hash guard. A valid creation
counterpart passes. Future schema fields therefore participate through the typed
serialization rather than a manually selected material-field list.

All **21 actual sandbox tests** and both independent Node replays pass on the final
artifact. Four native scenarios cover invalid receipt rollback, failed/competing
delivery, draft cancellation with actual sponsor/NFT returns, host-independent hard
grace and automatic NFT return after the original draw timeout. The fifth new test
covers the rules commitment and hostile material-field variants. Rust formatting
and both Clippy targets pass; the unchanged 380-package graph passes advisory/age
review. App inputs are unchanged: the 21-unit/29-PostgreSQL/15-Chromium/build result
from [private CI at d9ad39e](https://github.com/gueysito/show-up/actions/runs/41524703198)
is reused. This revision receives its own CI check after publication.

Final SHA-256: escrow `5b0043e8f0f241f158e5c71609ae6d95f9051a5b7d927a6cca47345e4f90592e`;
synthetic transfer harness `7a2e4a98b9331824b1978db72760f7270fa639cf8cc95b2f143758117a1203d8`.
Cargo lock remains `e72ea405fba148d85e351f1388fc24987d1d89f8d864df31c8e9e739bb2a29e7`.
The [NEP-171 receiver/resolver requirements](https://github.com/near/NEPs/blob/master/neps/nep-0171.md)
define the return boolean and source interface used here.

Scoped review checked token/ID/source binding, immutable terms/recipients, callback
privacy/attempt matching, bounded payloads, terminal/retry races, real ownership
and unchanged FT accounting. No web ingress, social data or private keys are added.
Fresh sandbox state is used; no funded public-contract upgrade/migration is claimed.
Qualification still needs real collection/code/authority approval, contributor fee
reserves and delivery-cost reconciliation, real canonical claim decisions, public
engineering evidence and deployment authority removal. The prototype's execution
uses disposable sandbox funds. No mainnet asset, provider signature, external custody
route, fee guarantee or later reward/claim stage is enabled by these tests.

## P5 read-only source comparison checkpoint, November 2

The [candidate registry](../manifests/rpc-candidates.v1.json) names two fixed public
read sources per required network. Its status is explicitly unqualified. The client
rejects arbitrary origins, redirects, write methods and raw NEAR state dumps. It
bounds requests/bodies, request IDs, per-attempt and overall time, and three-attempt
retry/backoff. Request encoding cannot execute serialization hooks. Large JSON-RPC
integers retain their original decimal bytes rather than JavaScript rounding; this
was verified in the pinned Node container as well as unit tests.

Comparison checks chain/genesis identity, fetches each source's finalized head,
then reads the lower common finalized height/slot from both. It requires the same
canonical hash, timestamp and Solana block height. Stale/future blocks, wrong chains,
duplicate source/operator claims or conflicts fail closed. Current technical lag
bounds are 30 minutes for finalized EVM heads and two minutes for NEAR/Solana; these
are comparison limits, not an asset/route approval or service guarantee.

Actual public metadata reads at **2026-11-02 21:59:53 UTC** matched all four:

| Network  | Compared finalized height/slot         | Result                    |
| -------- | -------------------------------------- | ------------------------- |
| NEAR     | 222778446                              | Matching hash/time        |
| Base     | 53432988                               | Matching hash/time        |
| Ethereum | 26329855                               | Matching hash/time        |
| Solana   | slot 464655171; block height 442676253 | Matching hash/time/height |

The first Ethereum candidate returned HTTP 525 after bounded retries. Its receipt
is retained in the approved ignored evidence directory; the current candidate uses
the [documented public dRPC endpoint](https://drpc.org/docs/ethereum-api), and the
subsequent comparison passed. No account, API key, purchase, wallet/address query,
signature, broadcast or asset transfer was involved. The successful receipt records
candidate-manifest canonical SHA-256
`206bea70efa25ed53c3fc434eb22e9effb8e781673a0f2e39654b5a35348e67d`.

All results keep **independenceVerified / assetEvidence / fundingAllowed false**.
Different endpoint/operator labels and matching headers do not prove independent
upstreams, NFT state, receipt attribution or payout completion. P5 signed exact-asset
observations, contract reconciliation and external-attempt recovery remain next.
Base's [separate L1/L2 fee components](https://docs.base.org/specifications/transactions/network-fees)
also remain distinct from P4's gas-envelope bound.

Twenty-six unit tests, format/lint/types and production build pass. Tests exercise
all four identity/finality branches, hostile identities/time/forks, large integers,
unsafe serializers, RPC correlation, network/HTTP/JSON-RPC retries and byte limits.
No contract, schema, UI or auth input changed; the 21-sandbox/29-PostgreSQL/15-Chromium
evidence from [private CI at f00e47b](https://github.com/gueysito/show-up/actions/runs/41529452668)
is reused. No signing/observer service is configured or qualified by this checkpoint.

Optional manual read-only reprobe:

```sh
node --import tsx scripts/probe-rpc-candidates.ts
```

## P5 signed observer boundary checkpoint, November 2

The sandbox contract now freezes a separate observer public key and a two-source
profile inside the complete rules commitment. Credential, attendance and draw keys
cannot fill that role. External-custody publication requires an unexpired signed
holding receipt. Receipts bind deployment, engineering manifest/chain, event/rules,
profile/sources, exact collection/asset/custody/owner, final block/slot/hash, times,
purpose and fees. Delivery additionally requires the already locked operation,
recipient, intent hash, stored transaction-image hash and transaction identifier.
It cannot change principal accounting or authorize a different payout.

Authenticated conflicting/regressing state latches a pause; later holding receipts
cannot silently clear it. Recovery still accepts a newer valid receipt for the
already fixed delivery/return while retaining the pause. A focused negative test
first reproduced a bug that suppressed this reconciliation, then passed after the
fix. Expired signatures cannot refresh publication readiness. Invalid signatures,
wrong contexts and insufficient finality are rejected without changing state.

Twenty-eight unit checks, format/lint/types and production build pass. All 24 local
sandbox scenarios passed; after the pause correction, focused conflict/recovery,
expiry/profile and expanded rules-hash checks passed against final WASM. Existing
escrow/attendance/native-NFT scenarios are reused for unchanged boundaries. Native
Node independently replays the three sandbox networks' accepted public observer
signatures and rejects changed fields/context/expiry. CI runs that replay too.
The canonical encoder also now sorts Unicode keys by UTF-8 bytes to match Rust;
a minimal counterexample and regression check cover JavaScript's differing order.
The final escrow WASM SHA-256 is
`5df2379d3fdf7ab97c5cb135af5754a44136ab629492c7d564ae505c401dbb0b`;
the test-token WASM and Cargo lock hashes are unchanged from the native checkpoint.
Both [private CI jobs at a381b4e](https://github.com/gueysito/show-up/actions/runs/41534835526)
also pass, including the unchanged 29 PostgreSQL and 15 Chromium scenarios.

This is **signed synthetic external-state evidence**, not an actual remote NFT
deposit or delivery. The observer remains trusted for truthful state, independent
upstreams and finality under [ADR-0002](adr/0002-nft-custody.md). No observer signing
service/key is configured, no real asset/profile is allowlisted, and no route is
qualified. Raw exact-asset RPC normalization and EVM nonce/Solana expiry recovery
remain P5 work. Base total fees, real MPC derivation/signing, authority/code review,
public-network approval and actual transfers remain gates. Fresh sandbox deployments
exercise the changed state schema; no funded/public state was migrated.

## P5 exact-asset source comparison checkpoint, November 2

Raw external evidence now reconstructs EIP-1559 transactions/signers and requires
the stored typed image, canonical finalized inclusion, exact ERC-721 Transfer log
and receipt outcome. Solana checks the actual wire signature/message, fixed Core
instruction/accounts, historical signature status, inclusion and exact integer
fees/balances. The narrow Core decoder rejects compressed assets, different
collections, unknown layouts and appended plugins. Collection/program authority
qualification remains false.

The fixed-source adapter compares both providers' normalized facts. EVM ownership
and code reads use [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898) canonical block
hashes. Solana requires identical actual account-response slots, with at most three
bounded attempts; it verifies that bank is finalized by both sources. Its
[minContextSlot](https://solana.com/docs/rpc/http/getaccountinfo) is only a lower
bound. Wrong chain, conflicting code/data/owner/history, missing inclusion and
unfinalized responses fail closed. Missing transaction/receipt/status remains
uncertain. No observation signs a receipt, changes an obligation or enables funding.

Historical delivery is separate from current holding: a recipient's later transfer
or burn cannot undo the earlier finalized payout. A focused negative test first
reproduced the retention mistake, then passed after this separation. Raw cost
evidence preserves known cap breaches; Base's full fee remains unqualified because
its [operator fee](https://docs.base.org/specifications/transactions/network-fees)
must accompany execution and L1 costs. Solana uses exact payer debit as well as
transaction fees; ambiguous debit cannot become a qualified total.

`npm run check` and `npm run build` pass in a clean snapshot of `582fdc9` plus only
these eight protocol/test files: **36 unit scenarios**, excluding concurrent auth
edits. The shared worktree's 38 checks/build also pass. The isolated build needed
physical dependency copies because Turbopack rejects the external dependency
symlink; project configuration was unchanged. The pinned Node 24 container separately
passes exact-u64 JSON transport checks. No contract/database/UI input changed;
[both CI jobs at 582fdc9](https://github.com/gueysito/show-up/actions/runs/41537401334)
provide reused 24-sandbox/29-PostgreSQL/15-Chromium evidence.

All asset/signature cases are disposable offline fixtures with keys only in memory.
No wallet file, live asset query, external signing service or broadcast was used.
Core layout references are pinned to [BaseAssetV1](https://github.com/metaplex-foundation/mpl-core/blob/a5c35db436fdb6382ac75b1d59205d769c4762ea/clients/rust/src/generated/accounts/base_asset_v1.rs)
and its generated UpdateAuthority/Key definitions at the same revision. Matching
facts do not qualify independent upstreams, code/upgrade authority, assets or fees.
Real source/asset qualification, signed historical-witness assembly and contract
nonce/blockhash recovery remain P5 work; every funding route stays disabled.

## P5 bounded custody recovery checkpoint, November 2

The sandbox retains up to three typed signing images under one immutable release
intent. A separately signed, fresh observer witness permits an EVM same-nonce fee
replacement, a next nonce after finalized failure, or a Solana replacement after
finalized failure or proved blockhash expiry. Solana expiry requires actual block
height, an invalid old hash and historical lookup of the known original signature.
An unknown original signature cannot authorize automatic rebuilding.

Recovery never replenishes the contributor's frozen fee budget. EVM reserves the
maximum exposure for each nonce; Solana keeps every earlier image's reservation.
Exact witness replay returns the original image without authorizing another attempt.
Changed payloads, stale witnesses, wrong signer/context, unresolved nonce/status,
reused blockhashes, exhausted reservations and a fourth image are rejected.
The three-image ceiling bounds this local experiment; it does not establish a live
provider request/retry policy. No MPC request or broadcaster is exposed.

Signed asset observations now use `showup.asset.observation.v2`, separating the
fresh finality checkpoint from historical transaction inclusion. Any retained
image can prove delivery to the fixed recipient, including a day-old transaction
after a replacement was prepared. A real delivery whose fee exceeds its image or
intent cap remains recorded and latches pause/fee review. It cannot authorize more
spending or alter principal accounting. Two deliberate negative sandbox cases
first failed against the old latest-image/fee predicate, then passed after this
change. Source independence/finality and truthful observer attestation remain trust
assumptions. Base total fees and Solana complete cost bounds remain unqualified.

Full `npm run contracts:check` passes: supply-chain gate, formatting, Rust lint,
WASM build, **29 sandbox scenarios** and four independent Node replays. Native Node
verifies four actual sandbox-accepted recovery witnesses and independently rebuilds
all typed histories, derivation paths and non-replenishing reservations. A clean
snapshot of `e9a79b6` plus only these changes passes **36 unit scenarios**, formatting,
lint, types and production build. Concurrent authentication work is excluded.
Unchanged PostgreSQL/browser inputs reuse
[both passing jobs at e9a79b6](https://github.com/gueysito/show-up/actions/runs/41544011494).

Escrow WASM SHA-256:
`7ff0209e37f6de611ae67437efbd9d09997893d9ea6878943849c86da9b7c4b8`.
The test-token WASM and Cargo lock hashes are unchanged. All signatures and assets
are disposable local fixtures. No private wallet file, public-network signature,
asset transfer, observer key configuration or funding route qualification is claimed.
Source-to-witness assembly and actual provider/asset qualification remain P5 work.

## Development authentication verification, November 2

The owner verified actual Telegram sign-in, refresh, logout/re-sign-in, explicit
Google linking and Google sign-in returning to the exact same account. Both
providers remain linked to one account. This clears the development authentication
setup gate; it does not establish actual-phone or production-release readiness.

The exact approved ngrok origin uses a production-mode app on loopback port 3445.
Its launcher parses the owner-only credential file as allowlisted data, preserves
existing application keys and disables the anonymous harness. Both fixed HTTPS
issuers use advertised `client_secret_post` authentication. Callback diagnostics
emit only allowlisted categories, never raw errors, provider bodies or claims.

Main-chat checks pass: format/lint/types, **40 unit tests**, and both real signed
OIDC fixture tests, including signature/issuer/audience/expiry/nonce/state/PKCE
rejection. Together the seven auth unit tests and two exchange tests provide nine
focused auth checks. The side chat's unchanged production-build evidence is reused;
remote CI verifies the committed inputs separately. Owner live-provider evidence
is distinguished from the fixture exchanges. No credential file or application key
was read, sourced, regenerated or committed during this checkpoint.

## Local custody signing interface checkpoint, November 2

The contract now requests signatures only for its retained typed image, fixed path
and frozen signing provider/domain. A direct key-derivation callback must match
the frozen custody address before publication when this policy is used. It verifies
ECDSA/Ed25519 responses, retains the exact signed wire image/transaction ID and binds
later delivery/failure/expiry observations to that original transaction. The caller
cannot submit a path, beneficiary or opaque signing hash.

One provider request is permitted per image, including after uncertain, failed,
malformed or oversized callbacks. Permissionless reconciliation verifies the
original signature without another provider call. Private callbacks require one
promise result; concurrent callers cannot send a second request. Image history,
irreversible intent and non-replenishing fee reservations remain enforced.

The interface is pinned to [near/mpc revision 0b098d0](https://github.com/near/mpc/tree/0b098d0e9951f658c3c9402480d23c09ca31620e),
including source hashes and explicit unqualified flags in
[the interface manifest](../manifests/signing-interface.v1.json). The SDK's existing
`unstable` feature exposes the NEAR `ecrecover` host function; no dependency version
was added or upgraded. Two already locked crypto dependencies are now explicit
test dependencies. All 380 registry versions pass the unchanged advisory/age policy.

Full contract checks pass: formatting, Rust lint, WASM, **32 sandbox scenarios**
and **five independent Node replays**. Three new sandbox tests each cover Base,
Ethereum and Solana, including wrong keys/context, races, public callback attempts,
oversized/malformed/failed replies, altered signatures and unrelated transaction IDs.
Native Node independently reconstructs the actual accepted wire transactions and
verifies signatures using Ethers and Node crypto. A clean scoped snapshot passes
36 unit tests/checks and production build; the combined auth worktree passes all
40 unit tests/checks. The running auth app and private credentials were untouched.

Read-only public testnet queries on November 2 compared
`public_key` and `derived_public_key` for domains 0/1 through NEAR public and FastNEAR
sources. Both returned matching public-key fingerprints and provider code hash
`CpGX8ywXJwvWPgZFDDCTCuPJBHF7BATT51gSfc3APERJ`. The probe used an explicitly
fictional predecessor and requested no signature, deployment or transfer. This
does not establish correspondence between the deployed code and the source pin,
actual Showup MPC derivation, provider availability, independent upstreams or fees.

SHA-256: escrow WASM `8fc16d71e71ab898bef1fe8dc4079b3f8467d6a650a66a71561696a0834650b4`;
test-token/mock WASM `4949b5cc3eb440a68997ea551fa2042a40d150287c5fa55c68453c7ab0006125`;
Cargo lock `01b6a0812b4e557e7792c6fe045c081575c1cf71b263788949b2a7e2b1682dab`.
All signing keys/assets are disposable local fixtures. Live signing, authority/key
removal, qualified source-to-witness integration, assets, complete fees and public
transfer evidence remain gates. Every funding route remains disabled.

## I4 wallet-control checkpoint, November 2

Authenticated accounts now verify wallets separately from social identity. Five-minute
challenges bind the HTTPS host/URI, network/chain, address, nonce, purpose and session.
EVM uses personal-message signatures; Solana verifies raw Ed25519 messages; NEAR
uses tagged NEP-413 Borsh/SHA-256 plus finalized full-access key membership from both
fixed sources. No browser proof, redirect or signature creates a funded seat.

Migration 005 stores challenges and own-wallet records under authenticated encryption
and keyed indexes. Challenge consumption, profile upsert, operation receipt and audit
are transactional. Account/session swaps, expired/revoked sessions, changed messages,
replay and concurrent consumption fail; rate limits are account-wide. Current session
and expiry are rechecked after NEAR reads. Responses/logs expose no private keys or
raw social-identity mapping; HTTP errors remain generic and origin guards stay strict.

Checks pass: **44 unit**, **36 PostgreSQL** and **18 Chromium scenarios**, formatting,
lint/types and isolated production build. Database checks include rollback of the
new tables without disturbing account/session data. The 32 contract scenarios/five
Node replays at [a94d053](https://github.com/gueysito/show-up/actions/runs/41554462794)
are unchanged and reused. The initial browser assertions also matched Next's route
announcer; scoping them to the wallet panel fixed the test without a product workaround.

Actual browser controls exercise disposable Base/Ethereum/Solana signatures,
durable refresh, keyboard focus, 390px layout, account isolation and lost-acknowledgement
recovery with exactly one signature. An Auckland browser timezone separately checks
stable UTC rendering. NEAR return parameters are removed from browser history; a
mismatched return fails, and its outbound URL is inspected behind a network intercept.
No external wallet was contacted. The final mobile screenshot is retained in the
approved ignored evidence directory. Production static bundles contain none of the
checked identity-key, private-file or server-crypto markers.

The public [NEP-413 example](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
was independently serialized with Rust Borsh 1.8.1/SHA-256, producing
`c9ce5de288f7de6d83e2303e56c7615949da83867ea33c0747ed45c47ef50148`.
Pinned Node 24.22.2 separately rejects the tested public weak-key counterexample.
The [MyNearWallet adapter](https://github.com/near/wallet-selector/blob/b532bcd7bacbe3027f7392b3ac8eb002ddacc19d/packages/my-near-wallet/src/lib/mnw-connect.ts)
supplies the reviewed public URL/parameter interface; no wallet SDK was installed.

All keys/signatures used by agent tests are disposable fixtures generated in memory.
The existing auth app and credential file were untouched. Actual wallet extensions,
MyNearWallet signing/return, live NEAR account membership and phones remain unverified.
This completes the wallet-control subset of I4; financial consent, capacity, escrow,
I5 and attendance remain incomplete. No route or full halfway completion is claimed.

## I4 financial consent checkpoint November 2

- `npm run check`: 48 unit tests, format, lint and types pass. All four disposable
  wallet families bind the complete financial message; even reconstructed messages
  with changed destinations/fees/rules fail without fresh wallet approval.
- Disposable test database, `npm run test:integration`: 43 checks pass, including
  immutable encrypted consent, lost-response replay, account/session/ID swaps,
  concurrent consumption, event/wallet revocation, expiry, fresh NEAR FullAccess
  checks and transactional migration rollback. Consent creates no reservation or seat.
- Isolated production build and all 18 Chromium scenarios pass, including existing
  account/host/wallet journeys. No new consent UI is claimed. Shared signature refactor retains the independent
  Rust NEP-413 vector; fixtures now keep one timestamp per block hash and explicitly
  reject conflicting timestamps, following the [NEAR block RPC](https://docs.near.org/api/rpc/block-chunk).
- Security review checked ownership, session/operation replay, strict schemas, exact
  integer bounds, parameterized SQL, encryption/AAD, rates and post-read expiry.
  No endpoint, CORS change, dependency, transaction, broadcast or running-tunnel change.
- This is an internal consent/storage seam. Caller-supplied quote hashes are not
  route qualification; contract enforcement, capacity/escrow integration, consent UI,
  real wallets, actual provider/funding and phones remain incomplete or externally gated.

## I4 settlement state checkpoint November 2

- `npm run check`: 52 unit tests, format, lint and types pass. Fixed-source mock
  reads reject wrong network/manifest/token, code/block substitutions, changed
  authorization/rules, impossible capacity, inconsistent accounting and source
  disagreement; u64 ledger versions retain exact values.
- Pinned Rust `lint-tests` and the focused `settlement_views_replay_actual_receipts_capacity_and_failed_refund_recovery`
  sandbox scenario pass. `node --import tsx scripts/check-settlement-state.ts`
  independently replays nine block-pinned actual sandbox states, including failed
  principal delivery followed by successful principal/excess returns. Public synthetic
  vectors are preserved in the approved ignored evidence directory; no private keys.
- Unchanged application journeys reuse `2bd48b0`'s 43 PostgreSQL, 18 Chromium and
  isolated production build evidence; unchanged deployed sandbox code reuses the
  32-scenario/five-replay baseline. Wallet `9a92964` has both private CI jobs passing.
- This is read-only state comparison. It creates no seat, reservation or payment.
  Monotonic persistence, app-to-contract financial binding, consent/escrow interfaces,
  actual source/profile/route qualification and wallet/phone checks remain open.

## I4 durable reconciliation checkpoint November 2

- `npm run check`: 52 unit tests, format, lint and types pass. Disposable test
  database `npm run test:integration`: all 53 checks pass, including ten journal
  scenarios for immutable encrypted profiles, retry/restart persistence, u64 values,
  concurrent/stale refreshes, outage recovery, permanent conflicts, monotonic refund
  counters, complete-row constraints and transactional schema rollback.
- A rolled-back probe reproduced PostgreSQL's NULL `CHECK` gap. A forward-only
  migration adds explicit populated-field counts; the repeated probe and all six
  partial-state variants now reject. Applied migration history and existing records
  remain intact; only the disposable test database received these migrations.
- Independent Node replay of all nine actual sandbox states still passes. The
  unchanged 18 Chromium/production-build and contract baseline evidence is reused.
  Both private CI jobs passed for consent `2bd48b0`; state-reader CI is separate.
- Reviewed immutable context/AAD binding, parameterized writes, lock scope, bounded
  encrypted current/conflict retention and typed source conflicts. No new endpoint,
  authority key, public write, worker activation or funding route is introduced.
  Financial-consent/contract binding, user interfaces, recovery controls and qualified
  live routes remain incomplete; this backend journal alone cannot enroll anyone.

## I4 native financial binding checkpoint November 2

- `npm run check`: 55 unit tests, format, lint and types pass. Full disposable
  PostgreSQL suite: 55 scenarios pass, including concurrent stable event-credential
  creation, preservation of existing consent identity and transactional migration rollback.
- Contract supply-chain review passes for all 380 locked packages. Chrono 0.4.45 was
  already locked/audited; only direct dependency edges were added. Pinned Rust format,
  both lint checks, fresh WASM and the full 35-scenario sandbox suite pass.
- All seven independent Node replays pass. New financial replay reconstructs the
  exact app wire and verifies wallet signatures against four actual sandbox states:
  reserved, funded after reservation expiry, released and paid principal. Credential
  authority substitutions, wrong actual source keys, missing financial proof and
  over-limit input cannot book a seat; excess/duplicate funds remain recoverable.
- Isolated production build and all 18 Chromium scenarios pass; all 18 implementation
  inputs match that snapshot. No auth internals appear in client bundles. Public
  synthetic vectors are in the approved ignored evidence directory, without private keys.
- Escrow WASM: `409aa768c6a11b3a5ea6d206e950be5fbe1e235ef15bed05a67eb076a3b6848c`;
  test token: `4949b5cc3eb440a68997ea551fa2042a40d150287c5fa55c68453c7ab0006125`;
  Cargo lock: `2aa6485989d8af5c70e07a3ea618e55fcd4cf78f5498c61ebc62eb1f04661ad3`.
- Checked strict schemas/amounts, event/deployment/asset/origin/nonce binding, canonical
  NEP-413 serialization, source signatures and actual signer, identity isolation,
  replay/races, expiry and principal conservation. Accepted-at eligibility attestation
  remains an identity-service trust boundary. This is fresh disposable native sandbox
  evidence; existing construction-only events without the new financial policy do
  not gain this guarantee. Real G1 routes, provider gas/fee qualification, consent UI,
  publication, public deployment/signing and actual wallets/phones remain incomplete
  or explicitly gated. The owner tunnel, real identities and private keys were untouched.

## I4 own financial records checkpoint November 2

- `npm run check`: format/lint/types and all 55 unit checks pass. Disposable PostgreSQL:
  57 checks pass, including stored-proof reconstruction/replay, re-sign-in, revoked
  sessions, cross-account cursor rejection and 52 records ordered within one millisecond.
- Isolated production build and all 19 Chromium scenarios pass. New journey: account
  link → approved terms → refresh → details/keyboard at 390px → logout/back. Another
  account cannot see the record or use its cursor; unknown filters return 400, unsigned
  access 401 and attempted payment writes 405. No CORS grant or proof/nonce is returned.
- Mobile screenshot was inspected in the isolated test output. Exact originals stay
  encrypted; sensitive reads are dynamic/no-store and account-scoped. Queries are
  parameterized; API limits are shared per account and errors disclose no internals.
  No dependency, wallet request, upload, public funding or production debug path was added.
- Three JSON imports now declare their native Node type, allowing the same server
  fixture path under Playwright and the application. Test discovery, units and build pass.
  Unchanged contract/supply-chain evidence is reused. Real keys were not read or changed.
- The owner app's port 3445 had no listener during this check; its live health was
  therefore not verified. One build accidentally ran in the main checkout; subsequent
  build/browser checks used an isolated copy. No server was restarted or deployed.
- New since the walkthrough: **Review your financial authorizations** shows an empty
  own-account list until real terms are prepared. Fictional fixture tests demonstrate
  approved records and explicit unconfirmed escrow; they do not demonstrate a real
  payment. Financial signing/escrow integration, publication and device gates remain open.

## I3 publication requirements checkpoint November 2

- Format/lint/types, 56 unit, 58 disposable PostgreSQL checks and isolated production
  build pass; all 19 Chromium scenarios pass. Saved-revision checks reject ID swaps,
  admin-without-host access, stale revisions, revoked roles/sessions and client-supplied
  verification flags. Publication remains 409 and the saved event remains a draft.
- Mobile host capture inspected. New since the walkthrough: save/reopen a private
  draft → **Check saved publication requirements** → see validation and unverified
  protocol prerequisites; edit without saving → hide that result and disable the check.
  No private answers or wallet directory appear in the response. Native/sandbox and
  provider/device limits from the preceding checkpoints remain in force.

## I4 owned reconciliation binding checkpoint November 2

- Format/lint/types and 56 unit checks pass. Full 58-check PostgreSQL suite plus the
  final 11-check consent subset pass: atomic linkage/replay, ownership, unchanged
  destinations, profile/code-hash replacement rejection, external-source rejection,
  source outage and migration rollback. An invalid binding leaves no linked watch.
- Isolated production build and all 20 Chromium scenarios pass; nine code inputs
  match the snapshot and no auth/proof/watch internals appear in client bundles.
  The new controlled-source journey shows waiting → unavailable → persistent pause;
  refresh and another failed read preserve the pause and explicit unconfirmed escrow.
  Mobile capture inspected. Own responses omit full context and other registrations.
- Apply migration 010 before reading history in a rebuilt app. No owner database
  migration, credential access, public transaction, new browser signing/funding API,
  source qualification or deployment occurred. Existing contract/provider/device
  limits remain. I5 privacy and attendance interfaces remain incomplete.

## I5 private account export checkpoint November 2

- Format/lint/types and 56 unit checks pass; all 60 disposable PostgreSQL checks pass.
  Own exported identities, wallets, original signatures/terms and authored answers
  remain account-scoped. Restricted deletion-state reads cannot regain normal money
  authority; disabled/revoked sessions fail. A consistent database snapshot uses
  sequential reads on one connection without driver queue warnings.
- Isolated production build and all 21 Chromium scenarios pass; nine code inputs
  match that snapshot. Actual JSON attachment, private headers, other-account isolation,
  cross-site/filter/write rejection, shared three-per-hour limit, mobile keyboard/reflow
  and logout denial pass. Mobile capture inspected; no auth/proof/watch internals
  appear in client bundles. Current public npm runtime audit: zero vulnerabilities.
- New since the walkthrough: **Account → Your data and export → Download your data
  as JSON** returns private own records, including explicit unconfirmed escrow.
  Only fictional records were exported during agent verification. No real credential,
  owner identity/database, on-chain record or deployed app was changed. Account deletion,
  qualified payment recovery and attendance interfaces remain incomplete.

## I5 deletion and restricted recovery checkpoint November 2

- Format/lint/types and 57 unit checks pass. Full 64-scenario disposable PostgreSQL
  suite passes: explicit confirmation, schema rollback, cross-account operation swaps,
  erasure of cleared records, preservation of original financial proofs/watch links,
  approval/deletion races, all-session revocation and same-identity restricted restoration.
  Disabled accounts still fail; pending accounts cannot link or regain normal authority.
- Isolated production build and all 23 Chromium scenarios pass; all 20 inputs match
  the snapshot. Actual controls, authenticated completion/refresh, URL-flag rejection,
  stale-session denial, Back navigation to account/host, restricted history/export and
  logout/restoration pass. Pending mobile capture inspected; client bundles omit
  auth/proof/watch internals. Current dependency evidence is unchanged: zero runtime advisories.
- New since the walkthrough: **Your data and export → Request account deletion**
  requires `DELETE` plus acknowledgment. **Destructive agent checks only:** fictional
  cleared accounts were erased; fictional approved records retained recovery access.
  Do not use the owner's linked development account for cleanup. No actual owner data,
  credential, public transaction or deployed app was changed.
- Current routes remain unqualified, so approved financial and published-event records
  cannot yet receive qualified deletion clearance. Retention automation, integrated
  principal-return controls, attendance and real wallet/phone checks remain incomplete.

## I5 deletion confirmation account binding checkpoint November 2

- A disposable two-account browser regression reproduced an unsafe 200 after the
  account cookie changed while confirmation remained open. The fixed build returns
  403, keeps both accounts active, and resets acknowledgment on confirmation reload.
- Standalone fix snapshot: format/lint/types, 58 unit, 65 PostgreSQL, production build
  and all 24 Chromium checks pass; all ten inputs match. Account, exact-session,
  operation, tamper and five-minute expiry checks run before deletion under the account
  lock. The page displays the current private account reference; mobile capture inspected.
- This corrects the preceding deletion checkpoint before owner-app deployment.
  Only fictional records were exercised. Retention enforcement remains incomplete;
  qualified financial clearance, attendance, public funding/signing and device gates remain.

CI follow-up: [run 41582962083](https://github.com/gueysito/show-up/actions/runs/41582962083)
passed contracts but exposed `ERR_ABORTED` when the financial-history test pressed
Back before its logout document finished. Delaying that response reproduced the
failure three times. Waiting for visible signed-out content passes five repetitions
and all 24 Chromium scenarios, retaining logout denial and Back privacy assertions.
Focused format/lint checks pass; application code is unchanged by this repair.

## I5 private receipt retention checkpoint November 2

- Format/lint/types and 60 unit checks pass; all 71 disposable PostgreSQL checks pass.
  Six new scenarios cover actual worker startup/clean shutdown, seven-day boundary
  equality, schema rollback/atomic erasure, preserved replay barriers and financial
  originals, missing-key progress, concurrent bounded workers and wrong-key rollback.
- Isolated production build and all 24 Chromium scenarios pass. Nine retention code
  inputs match the build snapshot; the logout-history repair is also included in
  the browser run. Existing 35 sandbox/seven Node evidence is unchanged.
- Worker maintenance retires independent control material after expiry plus seven
  days and ordinary transport/audit/completed-deletion receipts after 90 days. It
  retains operation barriers, pending holds, original financial proofs and watched
  debt. Event-bound material purge after qualified settlement remains incomplete.
  The private launcher reuses the existing parser/key without executing credentials;
  no owner database migration, deletion, worker start or credential read occurred.

## Shared attendance receipt checkpoint November 2

- Format/lint/types and all 64 unit checks pass. Opening/grace/cutoff equality,
  exact event/participant/registration binding, proof-class mismatch, unbooked,
  released, already-attended and live-source rejection, and every signed field/key
  substitution are exercised. Sandbox packets remain pending, never confirmed.
- Pinned Rust test Clippy and the affected actual sandbox scenario pass across
  online/physical modes. Four exported signed receipts independently match the Node
  wire builder; on-time/late classifications and paid original principal match
  contract-owned state. No contract source/WASM/lockfile changed; the other 34
  sandbox scenarios and seven prior Node replays retain their existing evidence.
  `contracts:check` now includes this eighth replay. Existing PostgreSQL/build/browser
  evidence is unchanged; no application route, database schema or UI changed.
- Receipt construction does not establish live-code possession, assigned-staff
  presence or complete reconciliation. Those interfaces/durable integrations remain
  next, alongside existing source qualification and phone gates. No operator key,
  credential, public transaction or deployed app was used.

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

At the original foundation checkpoint, milestone 4 was untouched. Ethereum's older public finality follow-up remains
unverified in this run; it does not block this local draft workspace.
