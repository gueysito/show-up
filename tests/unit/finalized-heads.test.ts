import assert from "node:assert/strict";
import test from "node:test";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { compareFinalizedHeads } from "../../src/server/protocol/finalized-heads";
import { networkIdentity, type Network } from "../../src/server/protocol/manifest";
import { ReadOnlyRpc } from "../../src/server/protocol/rpc";

const now = Math.floor(Date.now() / 1000) * 1000;
const ids = {
  near: ["near-public", "near-fastnear"],
  base: ["base-public", "base-publicnode"],
  ethereum: ["ethereum-publicnode", "ethereum-drpc"],
  solana: ["solana-public", "solana-publicnode"],
};
function pair(network: Network, scenario = "valid") {
  return ids[network].map(
    (id, index) =>
      new ReadOnlyRpc(id, async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        const wrong = index === 1 && scenario === "wrong-network";
        const stale = index === 1 && scenario === "stale";
        const seconds = Math.floor((now - (stale ? 7_200_000 : 12_000)) / 1000);
        let result: unknown;
        if (request.method === "eth_chainId")
          result = wrong ? "0x2" : `0x${BigInt(networkIdentity(network).chainId).toString(16)}`;
        else if (request.method === "eth_getBlockByNumber") {
          const height =
            request.params[0] === "finalized"
              ? index === 0
                ? 101
                : 100
              : Number(BigInt(request.params[0]));
          result = {
            number: `0x${height.toString(16)}`,
            hash:
              "0x" +
              (index === 1 && scenario === "fork"
                ? "f".repeat(64)
                : height.toString(16).padStart(64, "0")),
            timestamp: `0x${seconds.toString(16)}`,
          };
        } else if (request.method === "status")
          result = { chain_id: wrong ? "testnet" : "mainnet" };
        else if (request.method === "block") {
          const height = request.params.finality
            ? index === 0
              ? 201
              : 200
            : request.params.block_id;
          result = {
            header: {
              height,
              hash: encodeBase58(
                Buffer.alloc(32, index === 1 && scenario === "fork" ? 255 : height % 256),
              ),
              timestamp_nanosec: (BigInt(seconds) * 1_000_000_000n).toString(),
            },
          };
        } else if (request.method === "getGenesisHash")
          result = wrong ? encodeBase58(Buffer.alloc(32, 1)) : networkIdentity("solana").chainId;
        else if (request.method === "getSlot") result = index === 0 ? 301 : 300;
        else if (request.method === "getBlock")
          result = {
            blockhash: encodeBase58(
              Buffer.alloc(32, index === 1 && scenario === "fork" ? 255 : 44),
            ),
            blockHeight: 280,
            blockTime: seconds,
          };
        else throw new Error("Unexpected read method");
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      }),
  );
}

test("all four required networks compare one common finalized block while keeping qualification false", async () => {
  for (const network of ["near", "base", "ethereum", "solana"] as const) {
    const [first, second] = pair(network);
    const compared = await compareFinalizedHeads(network, first, second, now);
    assert.equal(compared.matched, true);
    assert.equal(
      compared.block.height,
      network === "near" ? "200" : network === "solana" ? "300" : "100",
    );
    assert.equal(compared.independenceVerified, false);
    assert.equal(compared.assetEvidence, false);
    assert.equal(compared.fundingAllowed, false);
  }
});
test("wrong identities, stale sources, conflicting blocks and duplicate operators cannot pass comparison", async () => {
  for (const network of ["near", "base", "ethereum", "solana"] as const) {
    for (const scenario of ["wrong-network", "stale", "fork"]) {
      const [first, second] = pair(network, scenario);
      await assert.rejects(compareFinalizedHeads(network, first, second, now));
    }
    const [first] = pair(network);
    await assert.rejects(compareFinalizedHeads(network, first, first, now), /Distinct/);
  }
});
