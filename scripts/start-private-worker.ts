import { spawn } from "node:child_process";
import { loadAuthEnvironment, privateWorkerEnvironment } from "./auth-environment";

async function start() {
  const args = process.argv.slice(2),
    migrate = args.length === 1 && args[0] === "--migrate";
  if (args.length && !migrate) throw new Error("Unknown private runtime action");
  const env = privateWorkerEnvironment(await loadAuthEnvironment());
  if (migrate) delete env.SHOWUP_IDENTITY_KEY;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", migrate ? "src/server/db/migrate.ts" : "src/worker/main.ts"],
    {
      env,
      stdio: "inherit",
    },
  );
  const stop = () => child.kill("SIGTERM");
  child.once("error", () => {
    console.error("Private local command could not start.");
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
  console.error(
    "Private local command refused. Check owner-only .env.auth, the existing encryption key and local migrations.",
  );
  process.exitCode = 1;
});
