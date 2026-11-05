import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function scopeForPaths(paths) {
  let verify = false;
  let contracts = false;
  for (const path of paths) {
    if (/\.md$/i.test(path) || /^(LICENSE|NOTICE)$/.test(path)) continue;
    if (/^docs\/.*\.(txt|png|jpe?g|gif|webp|svg|pdf)$/i.test(path)) continue;
    if (path.startsWith("contracts/") && !path.startsWith("contracts/sandbox-tests/fixtures/")) {
      contracts = true;
    } else if (
      /^(src\/components\/|public\/|tests\/(e2e|integration)\/)/.test(path) ||
      (path.startsWith("src/app/") && !path.startsWith("src/app/api/"))
    ) {
      verify = true;
    } else {
      // Shared server/protocol code, fixtures, dependencies, tooling and unknown paths.
      verify = true;
      contracts = true;
    }
  }
  return { verify, contracts };
}

export function ciScope(context, changedPaths) {
  if (
    context.event !== "push" ||
    !context.defaultBranch ||
    !context.ref.startsWith("refs/heads/") ||
    context.ref === `refs/heads/${context.defaultBranch}` ||
    !/^[0-9a-f]{40}$/.test(context.before) ||
    /^0+$/.test(context.before)
  )
    return { verify: true, contracts: true };
  try {
    return scopeForPaths(changedPaths(context.before));
  } catch {
    // Missing history or classification failure must retain full validation.
    return { verify: true, contracts: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scope = ciScope(
    {
      event: process.env.GITHUB_EVENT_NAME ?? "",
      ref: process.env.GITHUB_REF ?? "",
      defaultBranch: process.env.CI_DEFAULT_BRANCH ?? "main",
      before: process.env.CI_BEFORE_SHA ?? "",
    },
    (before) =>
      execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", before, "HEAD"], {
        encoding: "utf8",
        maxBuffer: 4_000_000,
      })
        .split("\0")
        .filter(Boolean),
  );
  const output = `verify=${scope.verify}\ncontracts=${scope.contracts}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  console.log(output.trim());
}
