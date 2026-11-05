import { canonicalJson } from "./canonical";
import { compareFinalizedHeads, type FinalizedHeader } from "./finalized-heads";
import { ReadOnlyRpc, unsigned } from "./rpc";
import { record } from "./quote-signature";

export const v1Deployment = {
  account: "showup-dev-14989f.near",
  owner: "14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc",
  publicKey: "ed25519:2PQ8rQ56kQV6dFeiMNwEmbbQvxiTXGFPLt2uk4UyU8cB",
  codeHash: "5ErodH9NRYPUMmh4k5DnQ3wnmj8Azqu68YtuqgNvVM5U",
  token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  writeOrigin: "https://rpc.mainnet.fastnear.com",
} as const;

export type V1Terms = {
  id: string;
  title: string;
  start_ms: number;
  end_ms: number;
  capacity: number;
  deposit: string;
  prize: string;
  sponsor: string;
  nft: null;
};
export type V1Snapshot = { block: FinalizedHeader; event: Record<string, unknown> | null };
export const v1TransactionUrl = (hash: string) => `https://nearblocks.io/txns/${hash}`;

export function v1EventTerms(event: Record<string, unknown>): V1Terms {
  return Object.fromEntries(
    ["id", "title", "start_ms", "end_ms", "capacity", "deposit", "prize", "sponsor", "nft"].map(
      (key) => [key, event[key]],
    ),
  ) as V1Terms;
}
export function matchesV1Terms(event: Record<string, unknown>, terms: V1Terms) {
  return canonicalJson(v1EventTerms(event)) === canonicalJson(terms);
}

export async function readV1Snapshot(
  eventId: string,
  transport: typeof fetch = fetch,
): Promise<V1Snapshot> {
  if (!/^[a-z0-9-]{1,64}$/.test(eventId)) throw new Error("Invalid V1 event reference");
  const clients = [
    new ReadOnlyRpc("near-fastnear", transport),
    new ReadOnlyRpc("near-drpc", transport),
  ];
  const signal = AbortSignal.timeout(30_000);
  const finality = await compareFinalizedHeads("near", clients[0], clients[1], Date.now(), signal);
  const events = await Promise.all(
    clients.map(async (client) => {
      const params = { account_id: v1Deployment.account, block_id: finality.block.hash };
      const [account, response] = await Promise.all([
        client.read("query", { ...params, request_type: "view_account" }, signal),
        client.read(
          "query",
          {
            ...params,
            request_type: "call_function",
            method_name: "get_event",
            args_base64: Buffer.from(canonicalJson({ event: eventId })).toString("base64"),
          },
          signal,
        ),
      ]);
      for (const value of [account, response]) {
        if (
          record(value).block_hash !== finality.block.hash ||
          unsigned(record(value).block_height, 64).toString() !== finality.block.height
        )
          throw new Error("V1 query block mismatch");
      }
      if (record(account).code_hash !== v1Deployment.codeHash)
        throw new Error("V1 deployment changed");
      const bytes = record(response).result;
      if (
        !Array.isArray(bytes) ||
        bytes.length > 65536 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        throw new Error("V1 event response size/encoding");
      const event: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return event === null ? null : record(event);
    }),
  );
  if (canonicalJson(events[0]) !== canonicalJson(events[1])) throw new Error("V1 sources disagree");
  if (events[0] && events[0].id !== eventId) throw new Error("V1 event mismatch");
  return { block: finality.block, event: events[0] };
}

export async function readV1Record(
  method: "get_registration" | "get_claim",
  id: string,
  block: FinalizedHeader,
  transport: typeof fetch = fetch,
) {
  if (!/^[a-z0-9:-]{1,132}$/.test(id)) throw new Error("Invalid V1 record reference");
  const values = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (endpoint) => {
      const result = record(
        await new ReadOnlyRpc(endpoint, transport).read(
          "query",
          {
            request_type: "call_function",
            account_id: v1Deployment.account,
            block_id: block.hash,
            method_name: method,
            args_base64: Buffer.from(
              canonicalJson({ [method === "get_registration" ? "registration" : "claim"]: id }),
            ).toString("base64"),
          },
          AbortSignal.timeout(20000),
        ),
      );
      if (
        result.block_hash !== block.hash ||
        unsigned(result.block_height, 64).toString() !== block.height
      )
        throw new Error("V1 record block mismatch");
      const bytes = result.result;
      if (
        !Array.isArray(bytes) ||
        bytes.length > 8192 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        throw new Error("V1 record encoding");
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return parsed === null ? null : record(parsed);
    }),
  );
  if (canonicalJson(values[0]) !== canonicalJson(values[1]))
    throw new Error("V1 record sources disagree");
  return values[0];
}
