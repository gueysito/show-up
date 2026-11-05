# Working on Showup

Standards baseline: adopted 2026-10-29

## Reading order

1. [README.md](README.md): what Showup is and how to run it.
2. [CURRENT_STATE.md](CURRENT_STATE.md): what works now and the next action.
3. [docs/plan.md](docs/plan.md): the sole task tracker — V1 work packages and the V2 roadmap.
4. [docs/prd.md](docs/prd.md): the full product vision. V1 is the subset defined in the plan.
5. [.standards/README.md](.standards/README.md): repository check maintenance.

## The goal: ship V1

V1 is one complete, polished, working loop on mainnet with small real amounts:

host creates an event → attendees deposit from NEAR, Solana, Base or Ethereum through
NEAR Intents → USDC lands in the Showup escrow on NEAR → attendees check in → the event
closes → attendees get their deposit back, no-show deposits are split equally among
attendees, and an optional prize (a USDC pot and/or an Ethereum NFT) goes to one
drawn attendee.

**Definition of done for V1 work: it works end to end, on mainnet, in the real app,
and someone watching the demo can see it happen.** A package is done when its journey
runs in the browser against real contract state and the transaction links are recorded
in the plan. Do not keep features disabled behind further proof obligations once they
work. Ship the working thing, then move on.

The full PRD is the V2 target. Anything not in the V1 work packages is V2: do not build
it, harden it, or write proofs for it now. If a V1 package needs a V2 piece to work,
use the smallest version that works and note the shortcut in the plan.

## Authority

The owner approves all V1 work packages in [the plan](docs/plan.md#v1-work-packages)
without per-step sign-off. That includes:

- NEAR mainnet account setup, escrow contract deployment and upgrades.
- Real mainnet transactions on NEAR, Solana, Base and Ethereum, including NEAR Intents
  (which has no testnet) and Chain Signatures, within the **V1 mainnet budget of 50 USD
  total** across all chains. Keep test deposits small (about 1–2 USD each).
- Testnets, sandboxes and local tooling, freely.
- Pushing commits to the active feature branch.

Still requires asking the owner first: spending beyond the V1 budget, merging to `main`,
paid purchases or subscriptions, hosting/deployment services, messages to real people,
and adding work packages or changing V1 scope.

Keep a running mainnet spend ledger in the plan (date, chain, purpose, amount, tx link).

## Repository rules

Keep this repository private until November 13, 2026. After that date the owner makes
it public. Write everything as if it will be read publicly.

Keep repository content about the product only: users, requirements, architecture and
working behavior. Never mention contests, competitions, submissions, judging, prizes
for the project itself, deadlines, or the owner's private motivations in repository
files or any GitHub metadata (commit messages, branch names, pull requests, issues).
(Showup's own event prizes are product features and are fine.)

Never commit credentials, private keys, seed phrases, personal records or raw
identity-to-wallet mappings. Local scratch belongs in ignored `.agents/`.

## Commands and code style

- Activate checks on a clone: `sh .standards/setup-hooks.sh`.
- Verify the baseline: `sh .standards/check-standards.sh`.
- Verify staged content: `sh .standards/check-standards.sh --staged`.
- Check whitespace: `git diff --cached --check`.

The baseline uses the existing standards kit, commit template and Git hooks.
Use `npm run format:check`, `npm run lint`, `npm run typecheck`,
`npm run test:unit` and `npm run build`; contracts use `npm run contracts:check`.
Database/browser checks and setup are in [setup](docs/setup.md). Keep imported kit
files unchanged. Never bypass hooks.

CI keeps `verify` and `contracts` as stable required checks. Documentation-only
feature pushes skip heavy jobs; app/contract changes select relevant jobs, while
shared code, dependencies and unknown paths run both. PRs, `main`, merge queues and
manual runs always validate fully. CI-routing-only pushes run the lightweight scope
tests; their failure also fails the required checks. Newer pushes cancel superseded checks. Validate
CI filtering locally with `node --test .github/ci-scope.test.mjs`; do not trigger
extra GitHub runs or use workflow path filters/skip markers that leave checks pending.

## How to work

- **Speed over ceremony.** Docs are short and factual. One line of evidence per
  finished package in the plan (what works + tx links). No evidence essays, no
  session logs, no competing task lists. Do not expand `docs/verification.md` or
  `docs/development-wallets.md` beyond keeping addresses and the budget accurate.
- **Rigor where money moves.** The escrow contract's money paths — deposit, refund,
  forfeiture split, prize draw, NFT release — must have contract tests that pass before
  mainnet deployment, and every mainnet deployment must be followed by one real small
  round trip. Everything else just has to work in the demo.
- **Honest README.** The README must describe only what actually runs, and must stay
  runnable from a fresh clone. Do not describe planned behavior as working.
- **Commits** explain `Why`, `Changed`, and `Verified` in a few short lines each
  (docs-only commits need `Why` and `Changed`). Code and its docs travel together.
- **Before pushing,** fetch, check ahead/behind, and resolve divergence first.
- **Stuck?** If one approach fails twice, switch to the simplest alternative that
  still delivers the user-visible result, note it in the plan, and keep going.
  Escalate to the owner only for budget, scope, or a genuine blocker.

Earlier ADRs remain the design reference. Where an ADR or the PRD demands more than V1
needs, V1 takes the simpler path recorded in the plan; the ADR stays as the V2 target.
