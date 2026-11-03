import { fork } from "node:child_process";
import type { AuthConfig } from "../src/server/auth/config";
import type { SandboxAttendanceGateway } from "../src/worker/attendance";

// The generated fixture encryption key travels only over private process IPC.
// No operator file or private wallet key is read, serialized or logged here.
export function deliveryProcess(
  config: Pick<AuthConfig, "encryptionKey" | "origin">,
  candidateId: string,
  gateway: SandboxAttendanceGateway,
  killAfterSubmission = false,
) {
  return new Promise<{ killed: boolean; status: string | null }>((resolve, reject) => {
    const child = fork(
      new URL("../tests/fixtures/attendance-delivery-process.ts", import.meta.url),
      [],
      {
        execArgv: ["--import", "tsx"],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          SHOWUP_ENV: "test",
          DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
        },
      },
    );
    let killed = false,
      status: string | null = null,
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, 25_000);
    child.on("error", () => {
      failed = true;
    });
    child.on("message", async (message: unknown) => {
      const value = message as {
        kind: string;
        id: number;
        method: string;
        params: unknown[];
        result: { status: string };
      };
      if (value.kind === "result") {
        status = value.result.status;
        return;
      }
      if (value.kind === "fixture-error") {
        failed = true;
        return;
      }
      if (value.kind !== "gateway") return;
      try {
        const signal = AbortSignal.timeout(10_000);
        let result: unknown;
        if (value.method === "read") result = await gateway.read(signal);
        else if (value.method === "sign")
          result = await gateway.sign(
            value.params[0] as Parameters<SandboxAttendanceGateway["sign"]>[0],
            signal,
          );
        else if (value.method === "submit") {
          await gateway.submit(
            value.params[0] as Parameters<SandboxAttendanceGateway["submit"]>[0],
            value.params[1] as string,
            signal,
          );
          if (killAfterSubmission) {
            killed = true;
            child.kill("SIGKILL");
            return;
          }
        } else throw new Error("Unknown delivery fixture method");
        if (child.connected)
          child.send({ kind: "gateway-result", id: value.id, ok: true, value: result });
      } catch {
        if (child.connected) child.send({ kind: "gateway-result", id: value.id, ok: false });
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!failed && ((killed && signal === "SIGKILL") || (code === 0 && status !== null)))
        resolve({ killed, status });
      else reject(new Error("Attendance delivery fixture process failed"));
    });
    child.send({
      kind: "start",
      candidateId,
      config: { encryptionKey: config.encryptionKey, origin: config.origin },
      context: gateway.context,
      evidencePublicKey: gateway.evidencePublicKey,
    });
  });
}
