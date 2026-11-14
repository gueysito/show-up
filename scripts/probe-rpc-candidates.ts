import { compareFinalizedHeads } from "../src/server/protocol/finalized-heads";
import { requiredNetworks } from "../src/server/protocol/manifest";
import { ReadOnlyRpc, rpcCandidates } from "../src/server/protocol/rpc";
import { canonicalHash } from "../src/server/protocol/canonical";

const results = [];
for (const network of requiredNetworks) {
  const sources = rpcCandidates.endpoints.filter((source) => source.network === network);
  if (sources.length !== 2)
    throw new Error("Expected two declared candidates per required network");
  try {
    results.push(
      await compareFinalizedHeads(
        network,
        new ReadOnlyRpc(sources[0].id),
        new ReadOnlyRpc(sources[1].id),
      ),
    );
  } catch (error) {
    results.push({
      network,
      matched: false,
      fundingAllowed: false,
      error: error instanceof Error ? error.message : "RPC probe failed",
    });
  }
}
process.stdout.write(
  JSON.stringify(
    {
      observedAt: new Date().toISOString(),
      manifestRevision: rpcCandidates.revision,
      manifestSha256: canonicalHash(rpcCandidates),
      scope:
        "Public chain identity/finalized header reads only; no asset, wallet, signing or funding request",
      results,
    },
    null,
    2,
  ) + "\n",
);
