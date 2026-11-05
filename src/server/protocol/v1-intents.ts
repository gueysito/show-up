import { v1Deployment, type V1Snapshot } from "./v1-escrow";
import { V1ReadOnlyRpc } from "./v1-rpc";
import { NearAccountNotFound, unsigned } from "./rpc";
import { record } from "./quote-signature";
import { canonicalJson } from "./canonical";

export const v1Intents = {
  account: "intents.near",
  codeHash: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk",
  accountFunding: "20000000000000000000000",
} as const;
export function v1RouteAccount(registrationId: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(registrationId))
    throw new Error("Invalid route account reference");
  return `r${registrationId.replaceAll("-", "")}.${v1Deployment.account}`;
}
export async function readV1RouteAccount(
  registrationId: string,
  snapshot: V1Snapshot,
  transport?: typeof fetch,
) {
  const account = v1RouteAccount(registrationId),
    facts = await Promise.all(
      ["near-fastnear", "near-drpc"].map(async (endpoint) => {
        const rpc = new V1ReadOnlyRpc(endpoint, transport),
          params = { account_id: account, block_id: snapshot.block.hash };
        let value: Record<string, unknown>;
        try {
          value = record(await rpc.read("query", { ...params, request_type: "view_account" }));
        } catch (error) {
          if (
            error instanceof NearAccountNotFound &&
            error.accountId === account &&
            error.blockHash === snapshot.block.hash &&
            error.blockHeight === snapshot.block.height
          )
            return null;
          throw error;
        }
        const keys = record(
          await rpc.read("query", { ...params, request_type: "view_access_key_list" }),
        );
        for (const result of [value, keys])
          if (
            result.block_hash !== snapshot.block.hash ||
            String(result.block_height) !== snapshot.block.height
          )
            throw new Error("Route account query block mismatch");
        const entries = keys.keys;
        if (
          value.code_hash !== "1".repeat(32) ||
          !Array.isArray(entries) ||
          entries.length !== 1 ||
          record(entries[0]).public_key !== v1Deployment.publicKey ||
          record(record(entries[0]).access_key).permission !== "FullAccess"
        )
          throw new Error("Route account authority changed");
        const amount = unsigned(value.amount, 128),
          storage = unsigned(value.storage_usage, 64) * 10000000000000000000n;
        if (amount < storage) throw new Error("Route account storage balance");
        return {
          account,
          nonce: unsigned(record(record(entries[0]).access_key).nonce, 64).toString(),
          liquid: (amount - storage).toString(),
          amount: amount.toString(),
        };
      }),
    );
  if (canonicalJson(facts[0]) !== canonicalJson(facts[1]))
    throw new Error("Route account sources disagree");
  return facts[0];
}
export async function readV1IntentsBalance(
  registrationId: string,
  snapshot: V1Snapshot,
  transport?: typeof fetch,
) {
  const balances = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (endpoint) => {
      const rpc = new V1ReadOnlyRpc(endpoint, transport),
        params = { account_id: v1Intents.account, block_id: snapshot.block.hash },
        [account, result] = await Promise.all([
          rpc.read("query", { ...params, request_type: "view_account" }),
          rpc.read("query", {
            ...params,
            request_type: "call_function",
            method_name: "mt_balance_of",
            args_base64: Buffer.from(
              canonicalJson({
                account_id: v1RouteAccount(registrationId),
                token_id: `nep141:${v1Deployment.token}`,
              }),
            ).toString("base64"),
          }),
        ]);
      for (const value of [account, result])
        if (
          record(value).block_hash !== snapshot.block.hash ||
          String(record(value).block_height) !== snapshot.block.height
        )
          throw new Error("Intents balance block mismatch");
      if (record(account).code_hash !== v1Intents.codeHash)
        throw new Error("Intents deployment changed");
      const bytes = record(result).result;
      if (
        !Array.isArray(bytes) ||
        bytes.length > 128 ||
        bytes.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
      )
        throw new Error("Intents balance encoding");
      return unsigned(JSON.parse(Buffer.from(bytes).toString("utf8")), 128).toString();
    }),
  );
  if (balances[0] !== balances[1]) throw new Error("Intents balance sources disagree");
  return balances[0];
}
