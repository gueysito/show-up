# Showup

Showup turns an RSVP into a refundable commitment. Attendees place a deposit,
check in, and recover their deposit less disclosed transaction fees. Sponsors fund rewards; optional quizzes
and attendance streaks add participation benefits. Hosts see reconciled
attendance and spending results.

The initial audience is wallet-familiar communities running X Spaces and small
in-person events. The proposed product is a responsive website with optional
PWA installation and Telegram reminders. Event audio stays on its existing platform.

**Status: product scoping.** This repository contains requirements and working
conventions. There is no runnable application, deployed contract, or validated
integration. No dependencies need to be installed to review the product.

## Start here

1. Read [current state](CURRENT_STATE.md) for what exists and the next action.
2. Read the [product requirements](docs/prd.md) for journeys, money rules,
   boundaries, proposed architecture, and acceptance criteria.
3. Use [the plan](docs/plan.md) as the single task tracker.
4. Read [AGENTS.md](AGENTS.md) before changing anything.

The [technical scope](docs/technical-scope.md) connects current platform
documentation to the unresolved choices and proof obligations in the PRD.
The accepted [framework and authentication decision](docs/adr/0001-application-and-authentication.md)
records the Next.js, Node.js, openid-client, and PostgreSQL session direction.
The [runtime and access requirements](docs/prd.md#165-runtime-and-exposure) select
Docker Compose and Railway, with invitation-only mainnet access and real
transactions under approved limits. These are planned capabilities, not a live service.

Project-only test account addresses and funding instructions are in
[development wallets](docs/development-wallets.md). No private keys are tracked.

## Repository checks

Git and Python 3 are required for the repository checks. On each new clone:

```sh
sh .standards/setup-hooks.sh
sh .standards/check-standards.sh
```

Setup activates the commit template and Git checks, preserving any existing
active hooks. The check should report the front door and baseline as passing.
See [standards maintenance](.standards/README.md) for scope and provenance.

All product behavior described here is planned. Technical sources in the PRD
are research references, not evidence that integrations work.
