import { createDatabase } from "../../src/server/db/client";
import { authConfig } from "../../src/server/auth/config";
import { attemptAttendanceCode } from "../../src/server/attendance/attempts";
import type { AttendanceEngineeringInput } from "../../src/server/attendance/admission";

if (
  process.env.SHOWUP_ENV !== "test" ||
  process.env.DATABASE_URL !== "postgresql://showup@127.0.0.1:55433/showup_test"
)
  throw new Error("Intake process fixture requires the fixed disposable database");
let started = false;
process.on("message", async (message: unknown) => {
  if (started || !message || typeof message !== "object") return;
  started = true;
  const input = message as {
    encryptionKey: string;
    indexKey: string;
    session: string;
    input: Parameters<typeof attemptAttendanceCode>[3];
    engineering: AttendanceEngineeringInput;
  };
  const { pool } = createDatabase();
  try {
    const config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: input.encryptionKey,
      SHOWUP_IDENTITY_INDEX_KEY: input.indexKey,
    });
    if (!config || input.engineering.source.context.environment !== "sandbox")
      throw new Error("Invalid generated fixture input");
    await attemptAttendanceCode(pool, config, input.session, input.input, input.engineering);
    process.send?.({ kind: "unexpected-completion" });
  } catch {
    process.send?.({ kind: "failure" });
  } finally {
    await pool.end();
    process.disconnect();
  }
});
