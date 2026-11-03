import { access } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { loadAuthEnvironment, tunnelEnvironment } from "./auth-environment";
import { approvedTunnelOrigin } from "../src/server/auth/config";

async function start() {
  const env = tunnelEnvironment(await loadAuthEnvironment());
  await access(".next/standalone/server.js");
  const checked = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-config.ts"], {
    env,
    stdio: "inherit",
  });
  if (checked.status !== 0) throw new Error("Startup configuration check failed");
  const child = spawn(process.execPath, [".next/standalone/server.js"], { env, stdio: "inherit" });
  console.log(`Tunnel app origin: ${approvedTunnelOrigin}; local upstream: http://127.0.0.1:3445`);
  function stop() {
    child.kill("SIGTERM");
  }
  child.once("error", () => {
    console.error("Tunnel app could not start. Check the local port and production build.");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (code) process.exitCode = code;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

start().catch(() => {
  // Never print private configuration, credentials or provider responses.
  console.error(
    "Tunnel startup refused. Check .env.auth provider fields, local migrations and npm run build.",
  );
  process.exitCode = 1;
});
