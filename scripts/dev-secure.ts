import { spawn } from "node:child_process";
import { authConfig } from "../src/server/auth/config";
import { loadAuthEnvironment } from "./auth-environment";
import { createLocalCertificate } from "./local-certificate";

const configured = await loadAuthEnvironment();
const config = authConfig(configured);
if (!config || config.origin !== "https://localhost:3443")
  throw new Error("Use the documented secure local configuration first");
const tls = await createLocalCertificate();
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3443",
    "--experimental-https",
    "--experimental-https-key",
    tls.privateKey,
    "--experimental-https-cert",
    tls.certificate,
  ],
  { stdio: "inherit", env: { ...process.env, ...configured, SHOWUP_HARNESS: "0" } },
);
function stop() {
  child.kill("SIGTERM");
}
child.once("exit", async (code) => {
  if (code) process.exitCode = code;
  await tls.dispose();
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
