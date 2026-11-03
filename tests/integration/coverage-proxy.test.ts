import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { accountFixtures } from "../fixtures/accounts";
import { startLoopbackCoverageProxy } from "../../scripts/loopback-coverage-proxy";
import {
  fenceAbandonedLoopbackCoverage,
  readLoopbackCoverage,
} from "../../src/server/attendance/coverage-recorder";
import { canonicalJson } from "../../src/server/protocol/canonical";

async function backend() {
  let received: () => void = () => {},
    release: () => void = () => {},
    truncate: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
      received = resolve;
    }),
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  const bodies: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts).toString("utf8");
    if (incoming.url === "/account") {
      outgoing.end("Fictional loopback backend");
      return;
    }
    bodies.push(body);
    let parsed: { hold?: boolean; unavailable?: boolean; partial?: boolean } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      outgoing.writeHead(400).end();
      return;
    }
    if (parsed.hold) {
      received();
      await hold;
    }
    if (outgoing.destroyed) return;
    if (parsed.partial) {
      outgoing.writeHead(200, { "content-length": "100" });
      outgoing.flushHeaders();
      outgoing.write("partial");
      truncate = () => outgoing.socket?.destroy();
    } else
      outgoing
        .writeHead(parsed.unavailable ? 503 : 202, { "content-type": "application/json" })
        .end('{"status":"fixture_only"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    bodies,
    blocked,
    release,
    truncate: () => truncate(),
    close: async () => {
      release();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
async function post(port: number, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  await response.arrayBuffer();
  return response.status;
}
function childProxy(target: number) {
  const child = fork("tests/fixtures/coverage-proxy-process.ts", [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      SHOWUP_ENV: "test",
      DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
    },
  });
  const ready = new Promise<{ epochId: string; port: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Coverage process startup timed out")), 10000);
    child.on("message", (message: unknown) => {
      const value = message as { kind: string; epochId: string; port: number };
      if (value.kind === "ready") {
        clearTimeout(timer);
        resolve(value);
      } else if (value.kind === "failure") {
        clearTimeout(timer);
        reject(new Error("Coverage process failed"));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Coverage process exited before readiness"));
    });
  });
  child.send({ kind: "start", target });
  return { child, ready };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  const [code, signal] = await exit;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}
test("actual loopback forwarding preserves payload bytes, records failures and partial responses, and keeps private values out of metadata", async () => {
  const f = await accountFixtures([]),
    upstream = await backend(),
    epochs: string[] = [];
  let proxy: Awaited<ReturnType<typeof startLoopbackCoverageProxy>> | undefined;
  try {
    proxy = await startLoopbackCoverageProxy(f.pool, upstream.port);
    epochs.push(proxy.epochId);
    const privateValue = `fictional-private-${randomUUID()}`,
      body = { action: "issue", credential: privateValue };
    assert.equal(await post(proxy.port, "/api/attendance/qr", body), 202);
    assert.equal(upstream.bodies[0], JSON.stringify(body));
    assert.equal(await post(proxy.port, "/api/attendance/check-in", { unavailable: true }), 503);
    const partial = await fetch(`http://127.0.0.1:${proxy.port}/api/attendance/check-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partial: true }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(partial.status, 200);
    upstream.truncate();
    await assert.rejects(partial.arrayBuffer());
    assert.equal(await post(proxy.port, "/api/attendance/qr", { padding: "x".repeat(3000) }), 202);
    await Promise.all([proxy.stop(), proxy.stop()]);
    const trace = await readLoopbackCoverage(f.pool, proxy.epochId);
    assert.equal(trace.counts?.find((row) => row.channel === "qr_issue")?.completed, "1");
    assert.equal(trace.counts?.find((row) => row.channel === "code_entry")?.unavailable, "2");
    assert.equal(trace.counts?.find((row) => row.channel === "unknown")?.unavailable, "1");
    assert.equal(canonicalJson(trace).includes(privateValue), false);
    assert.equal(canonicalJson(trace).includes("padding"), false);
    assert.equal(trace.sourceQualified, false);
    assert.equal(trace.liveSubmissionAllowed, false);
  } finally {
    await proxy?.stop();
    await upstream.close();
    await f.pool.query("DELETE FROM service_coverage_epochs WHERE id=ANY($1::uuid[])", [epochs]);
    await f.cleanup();
  }
});
test(
  "actual SIGKILL preserves an unfinished measured request; a replacement epoch cannot fill the lost interval",
  { timeout: 25000 },
  async () => {
    const f = await accountFixtures([]),
      upstream = await backend(),
      epochs: string[] = [],
      children: ChildProcess[] = [];
    try {
      const first = childProxy(upstream.port);
      children.push(first.child);
      const ready = await first.ready;
      epochs.push(ready.epochId);
      const pending = post(ready.port, "/api/attendance/check-in", { hold: true }).catch(
        () => undefined,
      );
      await upstream.blocked;
      await kill(first.child);
      await pending;
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*) FROM service_coverage_requests WHERE epoch_id=$1 AND completed_ms IS NULL",
            [ready.epochId],
          )
        ).rows[0].count,
        "1",
      );
      await new Promise((resolve) => setTimeout(resolve, 2100));
      await fenceAbandonedLoopbackCoverage(f.pool, ready.epochId);
      const old = await readLoopbackCoverage(f.pool, ready.epochId);
      assert.equal(old.hadGap, true);
      assert.equal(old.counts?.find((row) => row.channel === "code_entry")?.completed, "0");
      const next = childProxy(upstream.port);
      children.push(next.child);
      const replacement = await next.ready;
      epochs.push(replacement.epochId);
      assert.notEqual(replacement.epochId, ready.epochId);
      assert.equal(await post(replacement.port, "/api/attendance/check-in", {}), 202);
      const stopped = once(next.child, "exit");
      next.child.send({ kind: "stop" });
      await stopped;
      const fresh = await readLoopbackCoverage(f.pool, replacement.epochId);
      assert(fresh.startedMs > old.throughMs);
      assert.equal(fresh.counts?.find((row) => row.channel === "code_entry")?.completed, "1");
    } finally {
      for (const child of children) await kill(child);
      await upstream.close();
      await f.pool.query("DELETE FROM service_coverage_epochs WHERE id=ANY($1::uuid[])", [epochs]);
      await f.cleanup();
    }
  },
);
