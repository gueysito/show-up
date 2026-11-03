import { canonicalHash, canonicalJson } from "../protocol/canonical";
import { networkManifest } from "../protocol/manifest";
import type { WalletSignature } from "../wallets/proof";
import {
  consentNetwork,
  verifyCommitmentConsent,
  type CommitmentConsent,
  type SandboxConsentProfile,
} from "./consent";

// A UUID is an opaque 128-bit event credential. Zero-extension is a bijection,
// preserving it in the prototype's 32-byte identifier field without an alias map.
export function contractReference(uuid: string): string {
  if (
    typeof uuid !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
  )
    throw new Error("Invalid event credential");
  return uuid.replaceAll("-", "").padStart(64, "0");
}

export function contractAuthorization(
  origin: string,
  consent: CommitmentConsent,
  proof: WalletSignature,
  acceptedAt: number,
  profile?: SandboxConsentProfile,
) {
  if (!verifyCommitmentConsent(consent, proof, origin, acceptedAt, profile))
    throw new Error("The original event financial consent is required");
  const terms = consent.terms,
    event = contractReference(terms.event);
  const asset = (network: CommitmentConsent["terms"]["source"]["network"]) => {
    const selected = consentNetwork(network, profile).assets.find((item) => item.id === "usdc");
    if (!selected) throw new Error("USDC destination is not in the frozen profile");
    return selected.contract;
  };
  const envelope = canonicalJson({ consent, proof, acceptedAt });
  if (Buffer.byteLength(envelope) > 12288) throw new Error("Financial consent envelope bounds");
  return {
    authorization: {
      domain: profile ? "showup.sandbox.authorization.v1" : networkManifest.signingDomain,
      deployment: terms.deployment,
      manifest: terms.manifest,
      event,
      rules_hash: terms.rulesHash,
      registration: contractReference(terms.registration),
      participant: contractReference(terms.participant),
      wallet_tag: canonicalHash({
        format: "showup.funding.wallet.v1",
        deployment: terms.deployment,
        environment: terms.environment,
        manifest: terms.manifest,
        event,
        family: ["base", "ethereum"].includes(terms.source.network) ? "evm" : terms.source.network,
        address: terms.source.address,
      }),
      principal: terms.principal,
      source: {
        network: terms.source.network,
        asset: terms.inputAsset.contract,
        address: terms.source.address,
      },
      refund: {
        network: terms.refund.network,
        asset: asset(terms.refund.network),
        address: terms.refund.address,
      },
      payout: {
        network: terms.payout.network,
        asset: asset(terms.payout.network),
        address: terms.payout.address,
      },
      fee_cap: terms.withdrawalFeeMaximum,
      nonce: canonicalHash({
        format: "showup.commitment.nonce.v1",
        id: consent.id,
        nonce: consent.nonce,
      }),
      expires_ms: terms.authorizationExpiresAt,
      reservation_ms: terms.reservationExpiresAt,
      wallet_consent: envelope,
    },
    fundingAllowed: false as const,
  };
}
