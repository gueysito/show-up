import { setTimeout as pause } from "node:timers/promises";
import { ReadOnlyRpc } from "./rpc";

const livePacer = v1RpcPacer();
// Admission only. The signed write callback runs once; a failed response never
// authorizes another nonce, signature or transport retry.
export function v1PacedSubmission<T>(operation: () => Promise<T>) {
  return livePacer.run("https://rpc.mainnet.fastnear.com", operation);
}
const pacedTransport: typeof fetch = async (input, init) => {
  let response = await fetch(input, { ...init, redirect: "error" });
  if (response.status === 429) {
    const header = response.headers.get("retry-after"),
      now = Date.now();
    const raw =
      header && /^\d{1,8}$/.test(header)
        ? now + Number(header) * 1000
        : header
          ? Date.parse(header)
          : now + 10000;
    const until = Number.isSafeInteger(raw) && raw >= now ? raw : now + 10000;
    const origin = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).origin;
    livePacer.cooldown(origin, until);
    if (!header) {
      const headers = new Headers(response.headers);
      headers.set("retry-after", "10");
      response = new Response(response.body, { status: 429, headers });
    }
  }
  return response;
};
export class V1ReadOnlyRpc extends ReadOnlyRpc {
  private readonly paced: boolean;
  constructor(id: string, transport?: typeof fetch) {
    super(id, transport ?? pacedTransport);
    this.paced = transport === undefined;
  }
  override read(method: string, params: unknown, signal?: AbortSignal) {
    const operation = () => super.read(method, params, signal);
    return this.paced ? livePacer.run(this.endpoint.origin, operation, signal) : operation();
  }
}

export function v1RpcPacer(
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<unknown> = (milliseconds, signal) =>
    pause(milliseconds, undefined, { signal }),
  now: () => number = Date.now,
) {
  const pending = new Map<string, Promise<unknown>>(),
    next = new Map<string, number>();
  return {
    cooldown(origin: string, until: number) {
      next.set(origin, Math.max(next.get(origin) ?? 0, until + 1000));
    },
    async run<T>(origin: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const previous = pending.get(origin) ?? Promise.resolve();
      const admission = previous
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          if (!next.has(origin)) next.set(origin, now() + 1000);
          while (next.get(origin)! > now()) {
            await wait(next.get(origin)! - now(), signal);
            signal?.throwIfAborted();
          }
          signal?.throwIfAborted();
          next.set(origin, now() + 1000);
        });
      pending.set(
        origin,
        admission.then(
          () => undefined,
          () => undefined,
        ),
      );
      return admission.then(operation);
    },
  };
}
