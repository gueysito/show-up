import assert from "node:assert/strict";
import test from "node:test";
import { ciScope, scopeForPaths } from "./ci-scope.mjs";

const context = {
  event: "push",
  ref: "refs/heads/codex/feature",
  defaultBranch: "main",
  before: "a".repeat(40),
};
const full = { verify: true, contracts: true };

test("documentation-only feature pushes skip both heavy jobs", () => {
  assert.deepEqual(
    ciScope(context, () => ["README.md", "AGENTS.md", "docs/plan.md", "docs/flow.svg"]),
    { verify: false, contracts: false },
  );
});

test("app and contract changes select their relevant checks", () => {
  for (const path of [
    "src/app/page.tsx",
    "src/app/page.mdx",
    "src/components/event.tsx",
    "tests/e2e/host.spec.ts",
  ])
    assert.deepEqual(scopeForPaths([path, "docs/setup.md"]), { verify: true, contracts: false });
  for (const path of ["contracts/showup-v1/src/lib.rs", "contracts/Cargo.lock"])
    assert.deepEqual(scopeForPaths([path]), { verify: false, contracts: true });
  assert.deepEqual(scopeForPaths(["src/app/page.tsx", "contracts/showup-v1/src/lib.rs"]), full);
});

test("payment/security code, shared fixtures, dependencies and unknown files run both", () => {
  for (const path of [
    "src/app/api/events/route.ts",
    "src/server/protocol/routed-funding.ts",
    "contracts/sandbox-tests/fixtures/native-transaction.json",
    "tests/fixtures/consent.ts",
    "package.json",
    "package-lock.json",
    ".nvmrc",
    "scripts/contracts.sh",
    ".github/workflows/checks.yml",
    "docs/evidence/input.json",
    "unknown.config",
  ])
    assert.deepEqual(scopeForPaths([path]), full, path);
});

test("PRs, merge queues, manual runs, main and first pushes retain full validation", () => {
  for (const change of [
    { event: "pull_request" },
    { event: "merge_group" },
    { event: "workflow_dispatch" },
    { ref: "refs/heads/main" },
    { ref: "refs/tags/v1" },
    { before: "0".repeat(40) },
    { before: "invalid" },
    { defaultBranch: "" },
  ])
    assert.deepEqual(
      ciScope({ ...context, ...change }, () => ["README.md"]),
      full,
    );
});

test("missing diff history fails closed to full checks", () => {
  assert.deepEqual(
    ciScope(context, () => {
      throw new Error("Missing base");
    }),
    full,
  );
});
