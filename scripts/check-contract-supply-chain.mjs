import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { publicBytes } from "./public-response.mjs";

const root = new URL("../contracts/", import.meta.url);
const cache = new URL(".cache/audit/", root);
await mkdir(cache, { recursive: true });
const lock = await readFile(new URL("Cargo.lock", root), "utf8");
const policy = JSON.parse(await readFile(new URL("advisory-policy.json", root), "utf8"));
const reviewed = [];
const ageExceptions = [];
const deadline = Date.now() + 180_000;
const packages = lock
  .split("[[package]]")
  .slice(1)
  .map(parsePackage)
  .filter((item) => item.source);
for (const item of packages) {
  if (
    item.source !== "registry+https://github.com/rust-lang/crates.io-index" ||
    !/^[a-f0-9]{64}$/.test(item.checksum)
  )
    throw new Error(`Unreviewed dependency source/integrity: ${item.name}`);
}

function parsePackage(block) {
  const fields = Object.fromEntries(
    [...block.matchAll(/^(name|version|source|checksum) = "([^"]+)"$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  if (!fields.name || !fields.version) throw new Error("Invalid lockfile entry");
  return fields;
}

async function request(url, options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() >= deadline) throw new Error("Public dependency review deadline exceeded");
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))),
        redirect: "error",
        headers: {
          "User-Agent": "Showup-local-development/0.1",
          "Content-Type": "application/json",
        },
      });
      return JSON.parse((await publicBytes(response, 2_000_000)).toString("utf8"));
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

async function versionAge(item) {
  const file = new URL(`${item.name}-${item.version}.json`, cache);
  let data;
  try {
    if (Date.now() - (await stat(file)).mtimeMs > 6 * 3_600_000)
      throw new Error("Refresh public metadata");
    data = JSON.parse(await readFile(file, "utf8"));
  } catch {
    const result = await request(`https://crates.io/api/v1/crates/${item.name}/${item.version}`);
    data = { createdAt: result.version.created_at, yanked: result.version.yanked };
    await writeFile(file, JSON.stringify(data));
  }
  const date = Date.parse(data.createdAt);
  if (data.yanked || !Number.isFinite(date))
    throw new Error(`Yanked or invalid package metadata: ${item.name}`);
  const exception = policy.recentSecurityPatches.find(
    (entry) => entry.package === item.name && entry.version === item.version,
  );
  if (
    Date.now() - date < 7 * 86_400_000 &&
    exception &&
    Date.now() < Date.parse(exception.expires)
  ) {
    ageExceptions.push(exception);
    return;
  }
  if (Date.now() - date < 7 * 86_400_000)
    throw new Error(`Release-age/yanked gate: ${item.name}@${item.version} (${data.createdAt})`);
}

const issues = [];
for (let offset = 0; offset < packages.length; offset += 4) {
  if (Date.now() >= deadline)
    throw new Error("Public dependency review deadline exceeded; no complete audit");
  const group = packages.slice(offset, offset + 4);
  const results = await Promise.allSettled(group.map(versionAge));
  for (const result of results)
    if (result.status === "rejected") issues.push(result.reason.message);
  if (offset % 40 === 0)
    console.log(`Release-age review: ${Math.min(offset + 4, packages.length)}/${packages.length}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
}
for (let offset = 0; offset < packages.length; offset += 100) {
  const group = packages.slice(offset, offset + 100);
  const response = await request("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    body: JSON.stringify({
      queries: group.map((item) => ({
        package: { ecosystem: "crates.io", name: item.name },
        version: item.version,
      })),
    }),
  });
  if (!Array.isArray(response.results) || response.results.length !== group.length)
    throw new Error("Incomplete advisory response");
  response.results.forEach((result, index) => {
    if (result.next_page_token) issues.push(`Incomplete advisory pagination: ${group[index].name}`);
    for (const vuln of result.vulns ?? []) {
      const item = group[index];
      const review = policy.reviews.find(
        (entry) =>
          entry.package === item.name &&
          entry.version === item.version &&
          entry.advisory === vuln.id,
      );
      if (review?.classification === "unmaintained") reviewed.push({ ...review, id: vuln.id });
      else issues.push(`Advisory: ${item.name}@${item.version} ${vuln.id}`);
    }
  });
}
for (const review of reviewed) {
  const advisory = await request(`https://api.osv.dev/v1/vulns/${review.id}`);
  if (
    !advisory.affected?.some((entry) => entry.database_specific?.informational === "unmaintained")
  )
    issues.push(`Reviewed advisory classification changed: ${review.id}`);
}
const receipt = {
  checkedAt: new Date().toISOString(),
  lockSha256: createHash("sha256").update(lock).digest("hex"),
  packages: packages.length,
  issues,
  reviewed,
  ageExceptions,
};
await writeFile(new URL("receipt.json", cache), JSON.stringify(receipt, null, 2));
if (issues.length) throw new Error(issues.join("\n"));
console.log(
  `PASS: ${packages.length} locked registry packages; OSV checked, ${reviewed.length} exact maintenance reviews, ${ageExceptions.length} exact security age exceptions; ${receipt.lockSha256}`,
);
