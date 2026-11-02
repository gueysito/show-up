import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { publicBytes } from "./public-response.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../manifests/engineering.v1.json", import.meta.url), "utf8"),
);
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
if (!arch) throw new Error("Unsupported sandbox architecture");
const sandbox = manifest.toolchain.sandbox;
const expected = sandbox.archives[arch];
const cache = new URL("../contracts/.cache/", import.meta.url);
const bin = new URL("bin/", cache);
const archive = new URL(`near-sandbox-${sandbox.version}-${arch}.tar.gz`, cache);
const binary = new URL("near-sandbox", bin);
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv.includes("--verify")) {
  if (hash(await readFile(binary)) !== expected.binarySha256)
    throw new Error("Sandbox binary checksum mismatch");
  console.log(`Verified pinned local sandbox ${sandbox.version}/${arch}`);
} else {
  await mkdir(bin, { recursive: true });
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch {
    bytes = await download();
  }
  if (hash(bytes) !== expected.sha256) throw new Error("Sandbox archive checksum mismatch");
  execFileSync("tar", [
    "-xzf",
    fileURLToPath(archive),
    "-C",
    fileURLToPath(bin),
    "--strip-components=1",
    `${expected.platform}/near-sandbox`,
  ]);
  if (hash(await readFile(binary)) !== expected.binarySha256)
    throw new Error("Extracted sandbox checksum mismatch");
  console.log(
    `Prepared pinned local sandbox ${sandbox.version}/${arch}; no public keys or credentials loaded`,
  );
}

async function download() {
  const url = `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/${expected.platform}/${sandbox.version}/near-sandbox.tar.gz`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(90_000), redirect: "error" });
      const bytes = await publicBytes(response, 50_000_000);
      if (bytes.length > 50_000_000 || hash(bytes) !== expected.sha256)
        throw new Error("Sandbox integrity check failed");
      await writeFile(archive, bytes, { flag: "wx" });
      return bytes;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
