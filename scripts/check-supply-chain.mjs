import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const metadata = new Map();
const names = [
  ...new Set(
    Object.keys(lock.packages)
      .filter(Boolean)
      .map((path) => path.split("node_modules/").at(-1)),
  ),
];
async function loadMetadata() {
  while (names.length) {
    const name = names.pop();
    const response = await fetch(`https://registry.npmjs.org/${name}`);
    if (!response.ok) throw new Error(`Registry unavailable: ${name}`);
    metadata.set(name, await response.json());
  }
}
await Promise.all(Array.from({ length: 8 }, loadMetadata));
let checked = 0;
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  if (!entry.resolved?.startsWith("https://registry.npmjs.org/")) {
    throw new Error(`Non-registry resolution: ${path}`);
  }
  if (!entry.integrity?.startsWith("sha512-")) {
    throw new Error(`Missing SHA-512 integrity: ${path}`);
  }
  const name = path.split("node_modules/").at(-1);
  const data = metadata.get(name);
  const published = data.time?.[entry.version];
  if (!published || new Date(published).getTime() > cutoff) {
    throw new Error(`Seven-day release gate failed: ${name}@${entry.version}`);
  }
  const scripts = data.versions[entry.version].scripts ?? {};
  const hooks = ["preinstall", "install", "postinstall"].filter((key) => scripts[key]);
  if (hooks.length) console.log(`Blocked lifecycle hooks: ${name}@${entry.version}: ${hooks}`);
  checked++;
}
for (const [name, version] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unpinned direct dependency: ${name}`);
}
console.log(
  `PASS: ${checked} locked packages, registry URLs, integrity, exact pins, seven-day age`,
);
