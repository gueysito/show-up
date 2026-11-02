import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManifestStructure,
  engineeringManifest,
  networkManifest,
  requireFundingRoute,
  verifyAssetIdentity,
} from "../../src/server/protocol/manifest";

test("asset admission binds environment, revision, chain, exact contract, provider asset and decimals", () => {
  assertManifestStructure();
  for (const network of networkManifest.networks) {
    const asset = network.assets.find((entry) => entry.id === "usdc")!;
    const input = {
      environment: "mainnet",
      revision: networkManifest.revision,
      network: network.id,
      chainId: network.chainId,
      ...asset,
    };
    assert.equal(verifyAssetIdentity(input).id, "usdc");
    for (const changes of [
      { environment: "engineering" },
      { revision: "unknown" },
      { chainId: "wrong" },
      { contract: "USDC" },
      { decimals: 18 },
      { routeAsset: "wrong" },
    ])
      assert.throws(() => verifyAssetIdentity({ ...input, ...changes }));
    assert.throws(() => requireFundingRoute(network.id), /Funding disabled/);
  }
  assert.equal(engineeringManifest.networks.length, 4);
});

test("Base/Ethereum token and Solana cluster substitutions fail even for the same ticker", () => {
  const base = networkManifest.networks.find((entry) => entry.id === "base")!;
  const ethereum = networkManifest.networks.find((entry) => entry.id === "ethereum")!;
  const asset = base.assets[0];
  assert.throws(() =>
    verifyAssetIdentity({
      environment: "mainnet",
      revision: networkManifest.revision,
      network: "ethereum",
      chainId: ethereum.chainId,
      ...asset,
    }),
  );
  const solana = networkManifest.networks.find((entry) => entry.id === "solana")!;
  assert.throws(() =>
    verifyAssetIdentity({
      environment: "mainnet",
      revision: networkManifest.revision,
      network: "solana",
      chainId: engineeringManifest.networks.find((entry) => entry.id === "solana")!.chainId,
      ...solana.assets[0],
    }),
  );
});
