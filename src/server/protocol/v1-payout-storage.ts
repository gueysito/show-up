import { V1ReadOnlyRpc } from "./v1-rpc";
import { v1Deployment, type V1Snapshot } from "./v1-escrow";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";
import { canonicalJson } from "./canonical";
import { AppFailure } from "../http/security";

export async function v1PayoutStorageReady(
  account: string,
  snapshot: V1Snapshot,
  transport?: typeof fetch,
) {
  const facts = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (endpoint) => {
      const result = record(
        await new V1ReadOnlyRpc(endpoint, transport).read("query", {
          request_type: "call_function",
          account_id: v1Deployment.token,
          block_id: snapshot.block.hash,
          method_name: "storage_balance_of",
          args_base64: Buffer.from(canonicalJson({ account_id: account })).toString("base64"),
        }),
      );
      if (
        result.block_hash !== snapshot.block.hash ||
        String(result.block_height) !== snapshot.block.height ||
        !Array.isArray(result.result) ||
        result.result.length > 256 ||
        result.result.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        throw new Error("USDC receiving registration source mismatch");
      const value: unknown = JSON.parse(Buffer.from(result.result).toString("utf8"));
      return value === null
        ? null
        : {
            total: unsigned(record(value).total, 128).toString(),
            available: unsigned(record(value).available, 128).toString(),
          };
    }),
  );
  if (canonicalJson(facts[0]) !== canonicalJson(facts[1]))
    throw new Error("USDC receiving registration sources disagree");
  return facts[0] !== null && BigInt(facts[0].total) > 0n;
}
export async function requireV1PayoutStorage(
  account: string,
  snapshot: V1Snapshot,
  transport?: typeof fetch,
) {
  if (!(await v1PayoutStorageReady(account, snapshot, transport)))
    throw new AppFailure(
      422,
      "Enable USDC receiving for your NEAR payout wallet before paying from another chain.",
    );
}
