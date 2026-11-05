import { decodeBase58 } from "../protocol/encoding";
import { record } from "../protocol/quote-signature";
import { v1Deployment } from "../protocol/v1-escrow";
import { V1ReadOnlyRpc } from "../protocol/v1-rpc";
import type { V1RegistrationImage } from "./v1-registration";

function matchesDeposit(value: unknown, image: V1RegistrationImage) {
  try {
    const tx = record(value);
    if (
      tx.signer_id !== image.sender ||
      tx.receiver_id !== v1Deployment.token ||
      !Array.isArray(tx.actions) ||
      tx.actions.length !== 1
    )
      return false;
    const call = record(record(tx.actions[0]).FunctionCall);
    if (
      call.method_name !== "ft_transfer_call" ||
      String(call.deposit) !== "1" ||
      typeof call.args !== "string" ||
      call.args.length > 2048
    )
      return false;
    const args = record(JSON.parse(Buffer.from(call.args, "base64").toString("utf8")));
    return (
      Object.keys(args).sort().join() === "amount,msg,receiver_id" &&
      args.receiver_id === v1Deployment.account &&
      args.amount === image.amount &&
      args.msg === `deposit:${image.id}`
    );
  } catch {
    return false;
  }
}

async function indexRequest(path: "account" | "transactions", body: object, fetcher: typeof fetch) {
  const response = await fetcher(`https://tx.main.fastnear.com/v0/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Deposit index unavailable");
  return record(await response.json());
}

export async function findV1NativeDepositReceipt(
  image: V1RegistrationImage,
  registeredHeight: string,
  observedHeight: string,
  transport?: typeof fetch,
) {
  if (image.source) return null;
  const from = Number(registeredHeight),
    to = Number(observedHeight);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from)
    return null;
  try {
    // The index suggests a hash. It does not establish the payment's validity.
    const listing = await indexRequest(
      "account",
      {
        account_id: v1Deployment.account,
        is_receiver: true,
        is_success: true,
        from_tx_block_height: from,
        to_tx_block_height: to,
        limit: 20,
      },
      transport ?? fetch,
    );
    if (!Array.isArray(listing.account_txs) || !listing.account_txs.length || listing.resume_token)
      return null;
    const hashes = [
      ...new Set(
        listing.account_txs.map((item) => {
          const hash = record(item).transaction_hash;
          if (typeof hash !== "string") throw new Error("Invalid indexed transaction hash");
          decodeBase58(hash, 32);
          return hash;
        }),
      ),
    ];
    if (!hashes.length || hashes.length > 20) return null;
    const indexed = await indexRequest("transactions", { tx_hashes: hashes }, transport ?? fetch);
    if (!Array.isArray(indexed.transactions)) return null;
    const matching = indexed.transactions.filter((item) =>
      matchesDeposit(record(item).transaction, image),
    );
    if (matching.length !== 1) return null;
    const hash = record(record(matching[0]).transaction).hash;
    if (typeof hash !== "string" || !hashes.includes(hash)) return null;
    const verified = await Promise.all(
      ["near-fastnear", "near-drpc"].map(async (provider) => {
        const value = record(
          await new V1ReadOnlyRpc(provider, transport).read(
            "tx",
            {
              tx_hash: hash,
              sender_account_id: image.sender,
              wait_until: "FINAL",
            },
            AbortSignal.timeout(6000),
          ),
        );
        const status = record(value.status).SuccessValue;
        return (
          value.final_execution_status === "FINAL" &&
          record(value.transaction).hash === hash &&
          matchesDeposit(value.transaction, image) &&
          typeof status === "string" &&
          Buffer.from(status, "base64").toString("utf8") === JSON.stringify(image.amount)
        );
      }),
    );
    return verified.every(Boolean) ? hash : null;
  } catch {
    return null;
  }
}
