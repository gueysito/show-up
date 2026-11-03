import { fork } from "node:child_process";
import type { AuthConfig } from "../src/server/auth/config";
import type { SandboxAttendanceGateway } from "../src/worker/attendance";
import type { SandboxPrincipalGateway } from "../src/worker/principal-recovery";
import type { SandboxClosingGateway } from "../src/worker/attendance-closing";

// The generated fixture encryption key travels only over private process IPC.
// No operator file or private wallet key is read, serialized or logged here.
export function deliveryProcess(
  config: Pick<AuthConfig, "encryptionKey" | "origin">,
  candidateId: string,
  gateway: SandboxAttendanceGateway,
  killAfterSubmission = false,
) {
  return runProcess(config, candidateId, { kind: "attendance", gateway }, killAfterSubmission);
}
export function closingProcess(
  config: Pick<AuthConfig, "encryptionKey" | "origin">,
  checkpointId: string,
  gateway: SandboxClosingGateway,
  killAfterSubmission = false,
) {
  return runProcess(config, checkpointId, { kind: "closing", gateway }, killAfterSubmission);
}
export function principalProcess(
  config: Pick<AuthConfig, "encryptionKey" | "origin">,
  consentId: string,
  gateway: SandboxPrincipalGateway,
  killAfterSubmission = false,
) {
  return runProcess(config, consentId, { kind: "principal", gateway }, killAfterSubmission);
}
function runProcess(
  config: Pick<AuthConfig, "encryptionKey" | "origin">,
  jobId: string,
  input:
    | { kind: "attendance"; gateway: SandboxAttendanceGateway }
    | { kind: "closing"; gateway: SandboxClosingGateway }
    | { kind: "principal"; gateway: SandboxPrincipalGateway },
  killAfterSubmission: boolean,
) {
  const { gateway } = input;
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
        else if (value.method === "sign") {
          if (input.kind === "principal")
            throw new Error("Principal recovery has no new signing authority");
          result =
            input.kind === "attendance"
              ? await input.gateway.sign(
                  value.params[0] as Parameters<SandboxAttendanceGateway["sign"]>[0],
                  signal,
                )
              : await input.gateway.sign(
                  value.params[0] as Parameters<SandboxClosingGateway["sign"]>[0],
                  signal,
                );
        } else if (value.method === "submit") {
          if (input.kind === "attendance")
            await input.gateway.submit(
              value.params[0] as Parameters<SandboxAttendanceGateway["submit"]>[0],
              value.params[1] as string,
              signal,
            );
          else if (input.kind === "closing")
            await input.gateway.submit(
              value.params[0] as Parameters<SandboxClosingGateway["submit"]>[0],
              value.params[1] as string,
              signal,
            );
          else await input.gateway.submit(value.params[0] as string, signal);
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
      jobId,
      jobKind: input.kind,
      config: { encryptionKey: config.encryptionKey, origin: config.origin },
      context: gateway.context,
      evidencePublicKey: input.kind === "principal" ? "" : input.gateway.evidencePublicKey,
    });
  });
}
