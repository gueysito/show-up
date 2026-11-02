import { spawn } from "node:child_process";
import { authConfig } from "../src/server/auth/config";
import { loadAuthEnvironment } from "./auth-environment";

const configured = await loadAuthEnvironment();
const config = authConfig(configured);
if (!config || config.origin !== "https://localhost:3443")
  throw new Error("Use the documented secure local configuration first");
const children = [
  spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3104"],
    { stdio: "inherit", env: { ...process.env, ...configured } },
  ),
  spawn(process.execPath, ["--import", "tsx", "scripts/local-https.ts", "3443", "3104"], {
    stdio: "inherit",
  }),
];
function stop() {
  for (const child of children) child.kill("SIGTERM");
}
for (const child of children)
  child.once("exit", (code) => {
    if (code && !process.exitCode) process.exitCode = code;
    stop();
  });
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
