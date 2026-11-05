import type { WalletChallenge, WalletSignature } from "../../server/wallets/proof";

const relay = "https://near-mobile-production.aws.peersyst.tech";
const requestPath = "/connector/request";
const requestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export type NearMobileProofRequest = {
  id: string;
  challengeId: string;
  address: string;
  expiresAt: number;
};

async function request(url: string, payload?: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${relay}${url}`, {
    ...(payload && {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("NEAR Mobile request unavailable");
  return response.json();
}

export async function startNearMobileProof(
  challenge: WalletChallenge,
): Promise<NearMobileProofRequest> {
  if (
    challenge.network !== "near" ||
    challenge.nearTransport !== "near-mobile" ||
    challenge.origin !== window.location.origin ||
    challenge.expiresAt <= Date.now()
  )
    throw new Error("Invalid NEAR Mobile challenge");
  const payload = {
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: Array.from(atob(challenge.nonce), (byte) => byte.charCodeAt(0)),
    signerId: challenge.address,
  };
  const result = await request(requestPath, {
    method: "signMessage",
    network: "mainnet",
    origin: challenge.origin,
    payload,
  });
  const expiresAt = Date.parse(String(result.expiresAt));
  const echoed = result.payload as Partial<typeof payload> | undefined;
  if (
    typeof result.id !== "string" ||
    !requestId.test(result.id) ||
    result.status !== "pending" ||
    result.method !== "signMessage" ||
    result.origin !== challenge.origin ||
    result.network !== "mainnet" ||
    echoed?.signerId !== payload.signerId ||
    echoed.message !== payload.message ||
    echoed.recipient !== payload.recipient ||
    !Array.isArray(echoed.nonce) ||
    echoed.nonce.length !== payload.nonce.length ||
    !echoed.nonce.every((byte, index) => byte === payload.nonce[index]) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  )
    throw new Error("Invalid NEAR Mobile request");
  return {
    id: result.id,
    challengeId: challenge.id,
    address: challenge.address,
    expiresAt: Math.min(expiresAt, challenge.expiresAt),
  };
}

export function nearMobileApprovalUrl(id: string) {
  if (!requestId.test(id)) throw new Error("Invalid NEAR Mobile request");
  const url = new URL("/api/deep-link", relay);
  url.searchParams.set("path", "connector-request");
  url.searchParams.set("params", `id=${id}`);
  return url.href;
}

export async function readNearMobileProof(
  active: NearMobileProofRequest,
): Promise<WalletSignature | "pending" | "rejected" | "expired"> {
  if (active.expiresAt <= Date.now()) return "expired";
  const result = await request(`${requestPath}/${active.id}`);
  if (
    result.id !== active.id ||
    result.origin !== window.location.origin ||
    result.method !== "signMessage" ||
    result.network !== "mainnet"
  )
    throw new Error("Invalid NEAR Mobile response");
  if (result.status === "pending" || result.status === "rejected" || result.status === "expired")
    return result.status;
  const proof = result.response as Partial<WalletSignature> | undefined;
  if (
    result.status !== "approved" ||
    proof?.accountId !== active.address ||
    typeof proof.publicKey !== "string" ||
    !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(proof.publicKey) ||
    typeof proof.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature)
  )
    throw new Error("NEAR Mobile did not return the expected signature");
  return { accountId: proof.accountId, publicKey: proof.publicKey, signature: proof.signature };
}
