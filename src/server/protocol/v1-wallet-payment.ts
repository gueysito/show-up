import { V1ReadOnlyRpc } from "./v1-rpc";
import type { AuthConfig } from "../auth/config";
import { canonicalJson } from "./canonical";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";
import { v1Deployment, type V1Snapshot } from "./v1-escrow";
import { AppFailure } from "../http/security";
import {
  v1PrizeFundingTransaction,
  v1DepositFundingTransaction,
} from "../../../scripts/lib/native-engineering-transaction";

// Fixed native USDC payment. Wallet identity, amount and reference must come from
// the authenticated, frozen publication/registration record, never request fields.
export async function prepareV1WalletPayment(
  config: Pick<AuthConfig, "origin">,
  snapshot: V1Snapshot,
  wallet: { address: string; publicKey: string },
  eventId: string,
  reference: string,
  amount: string,
  purpose: "prize" | "deposit",
  transport?: typeof fetch,
) {
  const facts = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (endpoint) => {
      const rpc = new V1ReadOnlyRpc(endpoint, transport),
        signal = AbortSignal.timeout(20000);
      async function query(account_id: string, request_type: string, extra: object = {}) {
        const result = record(
          await rpc.read(
            "query",
            { account_id, request_type, block_id: snapshot.block.hash, ...extra },
            signal,
          ),
        );
        if (
          result.block_hash !== snapshot.block.hash ||
          String(result.block_height) !== snapshot.block.height
        )
          throw new Error("Payment wallet query block mismatch");
        return result;
      }
      const [account, access, balance, protocol] = await Promise.all([
        query(wallet.address, "view_account"),
        query(wallet.address, "view_access_key", { public_key: wallet.publicKey }),
        query(v1Deployment.token, "call_function", {
          method_name: "ft_balance_of",
          args_base64: Buffer.from(canonicalJson({ account_id: wallet.address })).toString(
            "base64",
          ),
        }),
        rpc.read("EXPERIMENTAL_protocol_config", { block_id: snapshot.block.hash }, signal),
      ]);
      const bytes = balance.result;
      if (
        !Array.isArray(bytes) ||
        bytes.length > 128 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        throw new Error("Payment balance encoding");
      const usdc: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (access.permission !== "FullAccess")
        throw new AppFailure(403, "Reverify a current full-access key for your funding wallet.");
      if (
        unsigned(account.amount, 128) < 160000000000000000000000n ||
        unsigned(usdc, 128) < BigInt(amount)
      )
        throw new AppFailure(
          422,
          "Your wallet needs the exact USDC amount and a separate NEAR gas reserve.",
        );
      if (
        record(protocol).chain_id !== "mainnet" ||
        record(protocol).protocol_version !== 87 ||
        unsigned(record(record(protocol).runtime_config).min_gas_purchase_price) > 1000000000n
      )
        throw new Error("Payment gas purchase policy changed");
      return unsigned(access.nonce, 64).toString();
    }),
  );
  if (facts[0] !== facts[1]) throw new Error("Payment wallet sources disagree");
  const build = purpose === "prize" ? v1PrizeFundingTransaction : v1DepositFundingTransaction;
  const tx = build({
    signer: wallet.address,
    publicKey: wallet.publicKey,
    nonce: (BigInt(facts[0]) + 1n).toString(),
    blockHash: snapshot.block.hash,
    eventId: reference,
    amount,
  });
  const callback = new URL(
    purpose === "prize" ? "/host" : `/events/${eventId}/commit`,
    config.origin,
  );
  if (purpose === "prize") callback.searchParams.set("event", eventId);
  const url = new URL("https://app.mynearwallet.com/sign");
  url.searchParams.set("transactions", tx.bytes.toString("base64"));
  url.searchParams.set("callbackUrl", callback.href);
  return {
    eventId,
    signer: wallet.address,
    amountAtomic: amount,
    token: v1Deployment.token,
    unsignedBase64: tx.bytes.toString("base64"),
    hash: tx.hash,
    walletUrl: url.href,
    maximumGasYoctoNear: "160000000000000000000000",
    attachedYoctoNear: "1",
  };
}
