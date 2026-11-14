import { createDatabase } from "../../src/server/db/client";
import { startLoopbackCoverageProxy } from "../../scripts/loopback-coverage-proxy";
if (
  process.env.SHOWUP_ENV !== "test" ||
  process.env.DATABASE_URL !== "postgresql://showup@127.0.0.1:55433/showup_test"
)
  throw new Error("Coverage process requires the fixed disposable database");
let proxy: Awaited<ReturnType<typeof startLoopbackCoverageProxy>> | undefined,
  started = false;
const { pool } = createDatabase();
process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const value = message as { kind: string; target: number };
  try {
    if (value.kind === "start" && !started) {
      started = true;
      proxy = await startLoopbackCoverageProxy(pool, value.target, { timeoutMs: 1000 });
      process.send?.({ kind: "ready", port: proxy.port, epochId: proxy.epochId });
    } else if (value.kind === "stop" && proxy) {
      await proxy.stop();
      await pool.end();
      process.send?.({ kind: "stopped" });
      process.disconnect();
    }
  } catch {
    process.send?.({ kind: "failure" });
    await pool.end();
    process.disconnect();
  }
});
