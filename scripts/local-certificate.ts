import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export async function createLocalCertificate() {
  const directory = await mkdtemp(join(tmpdir(), "showup-local-tls-"));
  const certificate = join(directory, "certificate.pem");
  const privateKey = join(directory, "key.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      privateKey,
      "-out",
      certificate,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  async function dispose() {
    await rm(directory, { recursive: true, force: true });
  }
  if (generated.status !== 0) {
    await dispose();
    throw new Error("Could not generate disposable local TLS certificate; OpenSSL is required");
  }
  return { certificate, privateKey, dispose };
}
