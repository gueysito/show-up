# Test the local event-draft workspace

The larger halfway goal is active and incomplete. UX-03–07 are implemented;
identity, funding, publication, contracts and attendance are not yet available.
The original foundation walkthrough below remains useful historical evidence.

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
