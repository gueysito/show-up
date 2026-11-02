# Local setup

This is an unfinished local application. Authentication, event publication,
wallet connections, funding and transfers are unavailable. Approved scope is
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

The baseline audit has **0 high/critical and 17 moderate development advisories**,
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

Identity code is implemented; live Google/Telegram registration and login remain
unverified. This starts only a local application and never creates provider accounts
or sends messages. Use fictional test accounts until the provider gate passes.

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
3. Register origin `https://localhost:3443` and exact callbacks
   `https://localhost:3443/api/auth/callback/google` and
   `https://localhost:3443/api/auth/callback/telegram` with the respective providers.
   If a provider rejects loopback callbacks, record that restriction; hosting or
   tunnels are not implicitly approved. Telegram uses OIDC client credentials,
   not a bot API token. Request only `openid profile`.
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
