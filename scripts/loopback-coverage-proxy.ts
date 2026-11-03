import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
  type ClientRequest,
} from "node:http";
import type pg from "pg";
import { canonicalHash } from "../src/server/protocol/canonical";
import {
  createLoopbackCoverageRecorder,
  type CoverageChannel,
} from "../src/server/attendance/coverage-recorder";

// Fixed local measurement inventory, not a qualified deployment inventory.
const inventory = {
  format: "showup.loopback.inventory.v1",
  routes: [
    ["POST", "/api/commitments", "admission"],
    ["POST", "/api/attendance/codes", "host_code"],
    ["POST", "/api/attendance/check-in", "code_entry"],
    ["POST", "/api/attendance/qr", "issue|scan|confirm"],
  ],
  probe: ["GET", "/account", 200],
  bodyInspectionLimit: 2048,
};
function routeChannel(message: IncomingMessage): CoverageChannel {
  if (message.method !== "POST") return "unknown";
  switch (message.url?.split("?", 1)[0]) {
    case "/api/commitments":
      return "admission";
    case "/api/attendance/codes":
      return "host_code";
    case "/api/attendance/check-in":
      return "code_entry";
    default:
      return "unknown";
  }
}
function qrAction(value: unknown): CoverageChannel | undefined {
  switch (value) {
    case "issue":
      return "qr_issue";
    case "scan":
      return "qr_scan";
    case "confirm":
      return "presence_confirmation";
  }
}
function readiness(target: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    };
    const probe = request(
      { hostname: "127.0.0.1", port: target, path: "/account", method: "GET" },
      (response) => {
        response.resume();
        response.once("end", () => finish(response.complete ? (response.statusCode ?? 0) : 0));
        response.once("error", () => finish(0));
        response.once("close", () => {
          if (!response.complete) finish(0);
        });
      },
    );
    const timer = setTimeout(() => {
      probe.destroy();
      finish(0);
    }, timeoutMs);
    probe.once("error", () => finish(0));
    probe.end();
  });
}
export async function startLoopbackCoverageProxy(
  pool: pg.Pool,
  target: number,
  options: { port?: number; expectedHost?: string; timeoutMs?: number } = {},
) {
  const listen = options.port ?? 0,
    timeoutMs = options.timeoutMs ?? 5000,
    expectedPort = Number(options.expectedHost?.split(":")[1]);
  if (
    !Number.isInteger(target) ||
    target < 1024 ||
    target > 65535 ||
    !Number.isInteger(listen) ||
    (listen !== 0 && (listen < 1024 || listen > 65535)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 15000 ||
    (options.expectedHost &&
      (!/^(localhost|127\.0\.0\.1):[0-9]{4,5}$/.test(options.expectedHost) ||
        expectedPort < 1024 ||
        expectedPort > 65535))
  )
    throw new Error("Choose bounded loopback measurement endpoints");
  const recorder = await createLoopbackCoverageRecorder(
      pool,
      canonicalHash({
        inventory,
        target,
        expectedHost: options.expectedHost ?? "bound-loopback-host",
      }),
    ),
    active = new Set<Promise<void>>(),
    upstreams = new Set<ClientRequest>();
  let closing = false,
    persistenceFailed = false,
    port = 0;
  async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    const expected = options.expectedHost;
    if (
      (expected
        ? incoming.headers.host !== expected
        : ![`127.0.0.1:${port}`, `localhost:${port}`].includes(incoming.headers.host ?? "")) ||
      !incoming.url?.startsWith("/") ||
      incoming.url.startsWith("//")
    ) {
      outgoing.writeHead(421).end();
      return;
    }
    let id: string;
    try {
      id = await recorder.begin(routeChannel(incoming));
    } catch {
      persistenceFailed = true;
      outgoing.writeHead(503).end("Service unavailable. Retry later.");
      return;
    }
    if (closing || incoming.aborted) {
      await recorder.complete(id, 499);
      outgoing.destroy();
      return;
    }
    const isQr =
      incoming.method === "POST" && incoming.url.split("?", 1)[0] === "/api/attendance/qr";
    let action: CoverageChannel | undefined,
      total = 0,
      parts: Buffer[] = [],
      bodyEnded = false;
    if (isQr)
      incoming.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total <= 2048) parts.push(Buffer.from(chunk));
        else {
          for (const part of parts) part.fill(0);
          parts = [];
        }
      });
    incoming.once("end", () => {
      if (isQr && total <= 2048) {
        try {
          action = qrAction(JSON.parse(Buffer.concat(parts).toString("utf8"))?.action);
        } catch {
          // Malformed input stays unknown; the backend decides its rejection.
        }
      }
      for (const part of parts) part.fill(0);
      parts = [];
      bodyEnded = true;
    });
    const headers = { ...incoming.headers };
    for (const name of Object.keys(headers))
      if (name.startsWith("x-forwarded-") || name === "forwarded") delete headers[name];
    await new Promise<void>((resolve) => {
      let settled = false;
      const finalize = async (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (isQr && bodyEnded && action) await recorder.classify(id, action);
          // A successful QR response without a complete identifiable request is
          // incomplete measurement, never a healthy success. No body wait can hang.
          const measured = isQr && code >= 200 && code < 400 && (!bodyEnded || !action) ? 0 : code;
          await recorder.complete(id, incoming.aborted && !incoming.complete ? 499 : measured);
        } catch {
          persistenceFailed = true;
        } finally {
          for (const part of parts) part.fill(0);
          parts = [];
          resolve();
        }
      };
      const proxied = request(
        {
          hostname: "127.0.0.1",
          port: target,
          path: incoming.url,
          method: incoming.method,
          headers,
        },
        (response) => {
          if (outgoing.destroyed) response.resume();
          else {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          }
          response.once("end", () => {
            void finalize(response.complete ? (response.statusCode ?? 0) : 0);
          });
          response.once("error", () => {
            outgoing.destroy();
            void finalize(0);
          });
          response.once("close", () => {
            if (!response.complete) {
              outgoing.destroy();
              void finalize(0);
            }
          });
          outgoing.once("close", () => {
            if (incoming.complete) response.resume();
          });
        },
      );
      upstreams.add(proxied);
      proxied.once("close", () => upstreams.delete(proxied));
      const timer = setTimeout(() => {
        proxied.destroy();
        if (!outgoing.headersSent) outgoing.writeHead(504);
        outgoing.end("Service unavailable. Retry later.");
        void finalize(0);
      }, timeoutMs);
      proxied.once("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end("Service unavailable. Retry later.");
        void finalize(0);
      });
      incoming.once("aborted", () => proxied.destroy());
      incoming.pipe(proxied);
    });
  }
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 10000,
      requestTimeout: 15000,
      connectionsCheckingInterval: 1000,
    },
    (incoming, outgoing) => {
      const operation = forward(incoming, outgoing).catch(() => {
        persistenceFailed = true;
        outgoing.destroy();
      });
      active.add(operation);
      void operation.finally(() => active.delete(operation));
    },
  );
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      server.removeListener("error", reject);
      resolve();
    });
  });
  const pulse = async () => {
    const code = await readiness(target, 750);
    try {
      await recorder.probe(persistenceFailed ? 0 : code);
      persistenceFailed = false;
    } catch {
      persistenceFailed = true;
    }
  };
  await pulse();
  let running = false;
  let stopping: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (!closing && !running) {
      running = true;
      void pulse().finally(() => {
        running = false;
      });
    }
  }, 500);
  return {
    port,
    epochId: recorder.epochId,
    stop: () =>
      (stopping ??= (async () => {
        closing = true;
        clearInterval(heartbeat);
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        for (const upstream of upstreams) upstream.destroy();
        await stopped;
        await Promise.allSettled([...active]);
        // Fence the interval callback before appending the immutable closing frame.
        while (running) await new Promise((resolve) => setTimeout(resolve, 10));
        await recorder.stop();
      })()),
  };
}
