import { setTimeout as delay } from "node:timers/promises";
import candidates from "../../../manifests/rpc-candidates.v2.json" with { type: "json" };
import { record } from "./quote-signature";
import { canonicalJson } from "./canonical";

export const rpcCandidates = candidates;
const allowed = {
  near: new Set(["status", "block", "query", "EXPERIMENTAL_protocol_config"]),
  evm: new Set([
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getTransactionCount",
    "eth_getCode",
    "eth_call",
  ]),
  solana: new Set([
    "getGenesisHash",
    "getSlot",
    "getBlockHeight",
    "getBlock",
    "getLatestBlockhash",
    "isBlockhashValid",
    "getSignatureStatuses",
    "getTransaction",
    "getAccountInfo",
  ]),
};

// JSON-RPC can encode u64 as JSON numbers. Preserve an unsafe integer's original
// decimal bytes rather than accepting a rounded JavaScript number.
export function parseRpcJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?[0-9]{1,78}$/.test(context.source))
        throw new Error("Ambiguous RPC integer encoding");
      return BigInt(context.source);
    }
    return value;
  });
}

export function unsigned(value: unknown, bits = 256): bigint {
  if (![64, 128, 256].includes(bits)) throw new Error("Unsupported RPC integer width");
  let result: bigint;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) result = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value))
    result = BigInt(value);
  else if (typeof value === "string" && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/.test(value))
    result = BigInt(value);
  else throw new Error("Invalid RPC integer");
  if (result < 0n || result >= 1n << BigInt(bits)) throw new Error("RPC integer bounds");
  return result;
}

async function responseJson(response: Response): Promise<unknown> {
  const maximum = 2 * 1024 * 1024;
  if (!response.body || Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("RPC response size limit");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new Error("RPC response size limit");
      chunks.push(value);
    }
    return parseRpcJson(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

export class ReadOnlyRpc {
  readonly endpoint;
  private nextId = 0;
  constructor(
    id: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const endpoint = candidates.endpoints.find((endpoint) => endpoint.id === id);
    if (!endpoint) throw new Error("Unregistered RPC endpoint");
    const origin = new URL(endpoint.origin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      origin.port
    )
      throw new Error("Invalid fixed RPC origin");
    this.endpoint = endpoint;
  }
  async read(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const family =
      this.endpoint.network === "near"
        ? "near"
        : this.endpoint.network === "solana"
          ? "solana"
          : "evm";
    if (!allowed[family].has(method)) throw new Error("Only read-only RPC methods are permitted");
    if (
      family === "near" &&
      method === "query" &&
      !["view_account", "view_access_key_list", "call_function"].includes(
        String(record(params).request_type),
      )
    )
      throw new Error("Unapproved read-only NEAR query");
    const id = ++this.nextId;
    const body = canonicalJson({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(body) > 16384) throw new Error("RPC request size limit");
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.transport(this.endpoint.origin, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        if (attempt === 2 || signal?.aborted) throw new Error("RPC service unavailable");
        await delay(250 * (attempt + 1), undefined, { signal });
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await delay(250 * (attempt + 1), undefined, { signal });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`RPC service unavailable (${response.status})`);
      }
      const envelope = record(await responseJson(response));
      const error =
        envelope.error && typeof envelope.error === "object" ? record(envelope.error) : undefined;
      if (
        envelope.jsonrpc === "2.0" &&
        envelope.id === id &&
        error &&
        [-32005, -32016, -32603].includes(Number(error.code)) &&
        attempt < 2
      ) {
        await delay(250 * (attempt + 1), undefined, { signal });
        continue;
      }
      if (
        envelope.jsonrpc !== "2.0" ||
        envelope.id !== id ||
        envelope.error !== undefined ||
        !("result" in envelope)
      )
        throw new Error("Invalid or failed RPC response");
      return envelope.result;
    }
    throw new Error("RPC service unavailable");
  }
}
