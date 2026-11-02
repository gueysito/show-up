# Repository standards

This folder carries the existing standards kit from Biggie Configs,
`shared/global-reference/coding/standards-kit`, adopted on October 29, 2026.
The GitHub Workflow v1 front-door and R1–R7 conventions govern this adoption.
The imported helper, launchers, template, and named-automation inventory are
maintained copies, not application code. Do not execute the automation listed
in that inventory; it supplies narrowly scoped commit-message exception evidence.

## Files and activation

- `standards.py`: staged-content, commit-message, front-door, and setup checks.
- `setup-hooks.sh`: activates the checks for a clone and preserves prior active hooks.
- `check-standards.sh`: verifies the baseline, or staged content with `--staged`.
- `commit-template.txt`: Why / Changed / Verified commit body.
- `AUTOMATED-COMMITS.md` and `AUTOMATED-COMMITS-EVIDENCE.json`: upstream exception inventory.
- `../.githooks/`: generated, tracked Git entrypoints.

Run setup on every clone; Git does not activate these hooks merely by cloning.
Git and Python 3 are prerequisites. No package install is required at this stage.

## Current scope and cost

The November 2 foundation adds pinned Prettier, ESLint, TypeScript and browser/
database checks; see [setup](../docs/setup.md). The imported helper and hooks are
unchanged. First-party JS/TS checks enforce the adopted readability rules.
Checks never install dependencies or rewrite the index.

- `pre-commit`: expected 0.5–3 seconds with code tooling; only local Python and Git
  startup plus staged-document inspection in the current repository.
- `commit-msg`: expected under 100 ms normally; up to 1 second for named-automation proof.

Any preserved hooks add their own cost. Documentation-only commits need nonempty
Why and Changed sections; other commits also require Verified. Do not bypass
checks or alter the index to make failures disappear.
