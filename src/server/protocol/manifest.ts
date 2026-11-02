import { createHash } from "node:crypto";
import mainnet from "../../../manifests/mainnet.v2.json";
import engineering from "../../../manifests/engineering.v1.json";

export const requiredNetworks = ["near", "base", "ethereum", "solana"] as const;
export type Network = (typeof requiredNetworks)[number];
export const networkManifest = mainnet;
export const engineeringManifest = engineering;
export const manifestHash = createHash("sha256").update(JSON.stringify(mainnet)).digest("hex");

export function networkIdentity(network: string) {
  const entry = mainnet.networks.find((item) => item.id === network);
  if (!entry) throw new Error("Unsupported network identity");
  return entry;
}

export function verifyAssetIdentity(input: {
  environment: string;
  revision: string;
  network: string;
  chainId: string;
  contract: string;
  decimals: number;
  routeAsset: string;
}) {
  if (input.environment !== "mainnet" || input.revision !== mainnet.revision)
    throw new Error("Wrong network environment or manifest revision");
  const network = networkIdentity(input.network);
  if (input.chainId !== network.chainId) throw new Error("Wrong chain identity");
  const contract = network.family === "evm" ? input.contract.toLowerCase() : input.contract;
  const asset = network.assets.find(
    (item) => item.contract === contract && item.routeAsset === input.routeAsset,
  );
  if (!asset || asset.decimals !== input.decimals)
    throw new Error("Unapproved asset identity or decimals");
  return asset;
}

export function requireFundingRoute(network: string): never {
  networkIdentity(network);
  // Qualification is deliberately not inferred from metadata or a browser flag.
  throw new Error(
    "Funding disabled: actual attributable escrow and authorized return proof is missing",
  );
}

export function assertManifestStructure() {
  for (const manifest of [mainnet, engineering]) {
    const ids = manifest.networks.map((item) => item.id);
    if (ids.length !== requiredNetworks.length || !requiredNetworks.every((id) => ids.includes(id)))
      throw new Error("Every required network must remain in the manifest");
  }
  if (mainnet.settlement.decimals !== 6 || mainnet.providers.oneClick.hasTestnet !== false)
    throw new Error("Invalid settlement or provider environment");
  for (const network of mainnet.networks) {
    if (network.routeState !== "disabled" || network.nftCollections.length !== 0)
      throw new Error("Unqualified routes and NFT collections must remain disabled");
  }
}
