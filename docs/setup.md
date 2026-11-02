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
worker and browser commands are introduced with the next foundation checkpoint.
