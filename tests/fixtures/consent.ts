import { randomUUID } from "node:crypto";
import { manifestHash, networkIdentity, type Network } from "../../src/server/protocol/manifest";
import { walletAddress } from "../../src/server/wallets/proof";
import type { ConsentTerms } from "../../src/server/commitments/consent";

// Fictional engineering terms only. This hash is not an authenticated quote,
// public deployment, source qualification or permission to transfer funds.
export function consentTerms(network: Network, address: string, now: number): ConsentTerms {
  const identity = networkIdentity(network);
  const wallet = { network, chainId: identity.chainId, address: walletAddress(network, address) };
  const input = identity.assets.find((asset) => asset.id === "usdc")!;
  return {
    environment: "mainnet",
    manifest: manifestHash,
    deployment: "fictional-escrow.near",
    event: randomUUID(),
    rulesHash: "a".repeat(64),
    registration: randomUUID(),
    participant: randomUUID(),
    timeZone: "America/Denver",
    source: { ...wallet },
    refund: { ...wallet },
    payout: { ...wallet },
    inputAsset: { contract: input.contract, decimals: input.decimals },
    maximumInput: "5100000",
    principal: "5000000",
    sourceGasMaximum: "100000",
    routingFeeMaximum: "100000",
    withdrawalFeeMaximum: "50000",
    payoutMinimum: "1000000",
    quoteHash: "b".repeat(64),
    quoteExpiresAt: now + 900_000,
    registrationClosesAt: now + 1_800_000,
    authorizationExpiresAt: now + 900_000,
    reservationExpiresAt: now + 300_000,
  };
}
