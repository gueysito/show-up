import { compareFinalizedHeads } from "../protocol/finalized-heads";
import { record } from "../protocol/quote-signature";
import { ReadOnlyRpc, unsigned } from "../protocol/rpc";
import type { WalletMessage, WalletSignature } from "./proof";

export class NearFullAccessRequired extends Error {}

export async function requireNearFullAccess(
  challenge: WalletMessage,
  proof: WalletSignature,
  transport: typeof fetch = fetch,
) {
  if (challenge.network !== "near" || !proof.publicKey)
    throw new Error("Expected NEAR wallet-control proof");
  const signal = AbortSignal.timeout(30_000);
  const first = new ReadOnlyRpc("near-public", transport);
  const second = new ReadOnlyRpc("near-fastnear", transport);
  const compared = await compareFinalizedHeads("near", first, second, Date.now(), signal);
  const check = async (client: ReadOnlyRpc) => {
    const raw = record(
      await client.read(
        "query",
        {
          request_type: "view_access_key_list",
          account_id: challenge.address,
          block_id: compared.block.hash,
        },
        signal,
      ),
    );
    if (
      raw.block_hash !== compared.block.hash ||
      unsigned(raw.block_height, 64).toString() !== compared.block.height ||
      !Array.isArray(raw.keys) ||
      raw.keys.length > 1000
    )
      throw new Error("NEAR access-key snapshot mismatch");
    return raw.keys.some((value) => {
      const entry = record(value);
      return (
        entry.public_key === proof.publicKey && record(entry.access_key).permission === "FullAccess"
      );
    });
  };
  const accepted = await Promise.all([check(first), check(second)]);
  if (accepted[0] !== accepted[1]) throw new Error("NEAR access sources disagree");
  if (!accepted[0]) throw new NearFullAccessRequired("Current FullAccess key required");
  return {
    blockHeight: compared.block.height,
    blockHash: compared.block.hash,
    sources: [first.endpoint.id, second.endpoint.id],
  };
}
