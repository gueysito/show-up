# Local setup

This is an unfinished local application. Authentication, event publication,
wallet connections, funding and transfers are unavailable. Approved scope is
F1–F4 and the event-draft subset of I3; see [the plan](plan.md).

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

## Start and stop

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
