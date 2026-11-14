import { createDatabase } from "../../src/server/db/client";
import {
  runSandboxAttendanceDelivery,
  type SandboxAttendanceGateway,
} from "../../src/worker/attendance";
import {
  runSandboxAttendanceClosing,
  type SandboxClosingGateway,
} from "../../src/worker/attendance-closing";
import {
  runSandboxPrincipalRecovery,
  type SandboxPrincipalGateway,
} from "../../src/worker/principal-recovery";
import type { AuthConfig } from "../../src/server/auth/config";

if (
  process.env.SHOWUP_ENV !== "test" ||
  process.env.DATABASE_URL !== "postgresql://showup@127.0.0.1:55433/showup_test"
)
  throw new Error("Delivery process fixture requires the fixed disposable database");
type Start = {
  kind: "start";
  jobId: string;
  jobKind: "attendance" | "closing" | "principal";
  failNeutral: boolean;
  config: Pick<AuthConfig, "encryptionKey" | "origin">;
  context: SandboxAttendanceGateway["context"];
  evidencePublicKey: string;
};
let sequence = 0,
  started = false;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: () => void }>();
function rpc(
  method: "read" | "sign" | "submit" | "failNeutral",
  params: unknown[],
  signal: AbortSignal,
) {
  return new Promise<unknown>((resolve, reject) => {
    const id = ++sequence;
    const cancel = () => {
      pending.delete(id);
      reject(new Error("Delivery fixture gateway unavailable"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    pending.set(id, {
      resolve: (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      reject: cancel,
    });
    process.send?.({ kind: "gateway", id, method, params });
  });
}
process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const response = message as { kind: string; id: number; ok: boolean; value: unknown };
  if (response.kind === "gateway-result") {
    const item = pending.get(response.id);
    pending.delete(response.id);
    if (response.ok) item?.resolve(response.value);
    else item?.reject();
    return;
  }
  if (started || response.kind !== "start") return;
  started = true;
  const input = message as Start,
    { pool } = createDatabase();
  try {
    if (
      Object.keys(input.config).sort().join() !== "encryptionKey,origin" ||
      !/^[0-9a-f]{64}$/.test(input.config.encryptionKey) ||
      input.config.origin !== "https://localhost:3444"
    )
      throw new Error("Invalid generated fixture configuration");
    const common = {
      context: input.context,
      evidencePublicKey: input.evidencePublicKey,
      read: async (signal: AbortSignal) =>
        (await rpc("read", [], signal)) as Awaited<ReturnType<SandboxAttendanceGateway["read"]>>,
    };
    let result;
    if (input.jobKind === "attendance") {
      const gateway: SandboxAttendanceGateway = {
        ...common,
        sign: async (receipt, signal) => (await rpc("sign", [receipt], signal)) as string,
        submit: async (receipt, signature, signal) => {
          await rpc("submit", [receipt, signature], signal);
        },
      };
      result = await runSandboxAttendanceDelivery(pool, input.config, input.jobId, gateway);
    } else if (input.jobKind === "closing") {
      const gateway: SandboxClosingGateway = {
        ...common,
        sign: async (checkpoint, signal) => (await rpc("sign", [checkpoint], signal)) as string,
        submit: async (checkpoint, signature, signal) => {
          await rpc("submit", [checkpoint, signature], signal);
        },
      };
      result = await runSandboxAttendanceClosing(pool, input.config, input.jobId, gateway);
    } else if (input.jobKind === "principal") {
      const gateway: SandboxPrincipalGateway = {
        context: common.context,
        read: common.read,
        ...(input.failNeutral
          ? {
              failNeutral: async (event: string, signal: AbortSignal) => {
                await rpc("failNeutral", [event], signal);
              },
            }
          : {}),
        submit: async (id, signal) => {
          await rpc("submit", [id], signal);
        },
      };
      result = await runSandboxPrincipalRecovery(pool, input.config, input.jobId, gateway);
    } else throw new Error("Unknown engineering job kind");
    process.send?.({ kind: "result", result });
  } catch {
    process.send?.({ kind: "fixture-error" });
    process.exitCode = 1;
  } finally {
    await pool.end();
    process.disconnect?.();
  }
});
