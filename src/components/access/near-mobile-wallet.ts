import type { WalletChallenge, WalletSignature } from "../../server/wallets/proof";
import type { prepareV1WalletPayment } from "../../server/protocol/v1-wallet-payment";

const relay = "https://near-mobile-production.aws.peersyst.tech";
const requestPath = "/connector/request";
const requestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export type NearWalletPayment = Awaited<ReturnType<typeof prepareV1WalletPayment>>;
export type NearMobilePaymentRequest = { id: string; expiresAt: number };

function sameRequest(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (Array.isArray(first) || Array.isArray(second))
    return (
      Array.isArray(first) &&
      Array.isArray(second) &&
      first.length === second.length &&
      first.every((item, index) => sameRequest(item, second[index]))
    );
  if (!first || !second || typeof first !== "object" || typeof second !== "object") return false;
  const keys = Object.keys(first);
  return (
    keys.length === Object.keys(second).length &&
    keys.every(
      (key) =>
        Object.hasOwn(second, key) &&
        sameRequest(
          (first as Record<string, unknown>)[key],
          (second as Record<string, unknown>)[key],
        ),
    )
  );
}

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
  const body = await response.text();
  if (body.length > 32_768) throw new Error("NEAR Mobile response was too large");
  return JSON.parse(body);
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

export function nearMobileAppUrl(id: string) {
  if (!requestId.test(id)) throw new Error("Invalid NEAR Mobile request");
  return `near-mobile-wallet://connector-request?id=${id}`;
}

export async function startNearMobilePayment(
  payment: NearWalletPayment,
): Promise<NearMobilePaymentRequest> {
  const payload = payment.walletTransaction;
  const origin = window.location.origin;
  const result = await request(requestPath, {
    method: "signAndSendTransaction",
    network: "mainnet",
    origin,
    payload,
  });
  const expiresAt = Date.parse(String(result.expiresAt));
  if (
    typeof result.id !== "string" ||
    !requestId.test(result.id) ||
    result.method !== "signAndSendTransaction" ||
    result.origin !== origin ||
    result.network !== "mainnet" ||
    result.status !== "pending" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !sameRequest(result.payload, payload)
  )
    throw new Error("NEAR Mobile did not preserve the reviewed payment request.");
  return { id: result.id, expiresAt };
}

export async function readNearMobilePayment(active: NearMobilePaymentRequest) {
  if (!requestId.test(active.id)) throw new Error("Invalid NEAR Mobile payment request");
  const result = await request(`${requestPath}/${active.id}`);
  if (
    result.id !== active.id ||
    result.origin !== window.location.origin ||
    result.method !== "signAndSendTransaction" ||
    result.network !== "mainnet" ||
    !["pending", "rejected", "expired", "approved"].includes(String(result.status))
  )
    throw new Error("Could not check the original NEAR Mobile payment.");
  return result.status as "pending" | "rejected" | "expired" | "approved";
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
