import { randomBytes, randomUUID } from "node:crypto";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import { manifestHash, networkIdentity, type Network } from "../protocol/manifest";
import { integerAmount } from "../protocol/one-click";
import {
  walletAddress,
  verifyWalletMessageSignature,
  type WalletSignature,
} from "../wallets/proof";

export type ConsentWallet = { network: Network; chainId: string; address: string };
export type ConsentTerms = {
  environment: "mainnet";
  manifest: string;
  deployment: string;
  event: string;
  rulesHash: string;
  registration: string;
  participant: string;
  timeZone: string;
  source: ConsentWallet;
  refund: ConsentWallet;
  payout: ConsentWallet;
  inputAsset: { contract: string; decimals: number };
  maximumInput: string;
  principal: string;
  sourceGasMaximum: string;
  routingFeeMaximum: string;
  withdrawalFeeMaximum: string;
  payoutMinimum: string;
  quoteHash: string;
  quoteExpiresAt: number;
  registrationClosesAt: number;
  authorizationExpiresAt: number;
  reservationExpiresAt: number;
};
export type CommitmentConsent = {
  format: "showup.commitment.consent.v1";
  id: string;
  origin: string;
  nonce: string;
  issuedAt: number;
  signingExpiresAt: number;
  terms: ConsentTerms;
  termsHash: string;
  message: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
function exact(value: object, keys: string) {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !== keys
  )
    throw new Error("Unexpected consent fields");
}
function wallet(value: ConsentWallet) {
  exact(value, "address,chainId,network");
  if (
    value.chainId !== networkIdentity(value.network).chainId ||
    value.address !== walletAddress(value.network, value.address) ||
    /^0x0{40}$/.test(value.address)
  )
    throw new Error("Invalid consent wallet identity");
}
export function validateConsentTerms(terms: ConsentTerms, issuedAt: number) {
  exact(
    terms,
    "authorizationExpiresAt,deployment,environment,event,inputAsset,manifest,maximumInput,participant,payout,payoutMinimum,principal,quoteExpiresAt,quoteHash,refund,registration,registrationClosesAt,reservationExpiresAt,routingFeeMaximum,rulesHash,source,sourceGasMaximum,timeZone,withdrawalFeeMaximum",
  );
  if (
    terms.environment !== "mainnet" ||
    terms.manifest !== manifestHash ||
    !uuid.test(terms.event) ||
    !uuid.test(terms.registration) ||
    !uuid.test(terms.participant) ||
    !digest.test(terms.rulesHash) ||
    !digest.test(terms.quoteHash) ||
    walletAddress("near", terms.deployment) !== terms.deployment
  )
    throw new Error("Invalid consent deployment or event binding");
  if (typeof terms.timeZone !== "string" || terms.timeZone.length > 100)
    throw new Error("Invalid consent timezone");
  new Intl.DateTimeFormat("en", { timeZone: terms.timeZone });
  for (const selected of [terms.source, terms.refund, terms.payout]) wallet(selected);
  if (terms.refund.network !== terms.source.network)
    throw new Error("Source refunds must return on the source network");
  exact(terms.inputAsset, "contract,decimals");
  const asset = networkIdentity(terms.source.network).assets.find(
    (item) => item.contract === terms.inputAsset.contract,
  );
  if (
    !asset ||
    asset.decimals !== terms.inputAsset.decimals ||
    (terms.source.network === "ethereum" && asset.id !== "usdc")
  )
    throw new Error("Unapproved funding asset");
  const principal = integerAmount(terms.principal);
  const maximum = integerAmount(terms.maximumInput);
  const withdrawal = integerAmount(terms.withdrawalFeeMaximum);
  const minimum = integerAmount(terms.payoutMinimum);
  integerAmount(terms.sourceGasMaximum);
  integerAmount(terms.routingFeeMaximum);
  if (
    principal < 2_500_000n ||
    maximum === 0n ||
    minimum === 0n ||
    withdrawal >= principal ||
    principal - withdrawal < minimum
  )
    throw new Error("Principal or net payout cannot meet the consent limits");
  const times = [
    issuedAt,
    terms.authorizationExpiresAt,
    terms.reservationExpiresAt,
    terms.registrationClosesAt,
    terms.quoteExpiresAt,
  ];
  if (
    !times.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    terms.authorizationExpiresAt <= issuedAt ||
    terms.authorizationExpiresAt > issuedAt + 30 * 60_000 ||
    terms.authorizationExpiresAt > Math.min(terms.registrationClosesAt, terms.quoteExpiresAt) ||
    terms.reservationExpiresAt !==
      Math.min(issuedAt + 300_000, terms.registrationClosesAt, terms.authorizationExpiresAt)
  )
    throw new Error("Invalid consent, reservation or quote expiry");
}

function message(consent: Omit<CommitmentConsent, "message">) {
  return [
    "Showup event financial consent v1",
    `Website: ${consent.origin}`,
    "Authorize only the event and limits below. A separate wallet transaction is required to transfer funds.",
    "A signature, quote or reservation creates no funded seat. Enrollment requires actual attributable escrow.",
    "Principal and payout limits use USDC atomic units (1 USDC = 1000000).",
    "Maximum input uses the selected input asset units. Source gas maximum uses native atomic units.",
    "Routing and withdrawal fee maxima use USDC atomic units. The platform fee is zero.",
    "Principal returns less disclosed, authorized delivery fees. Unresolved amounts remain recoverable.",
    `Consent: ${consent.id}`,
    `Nonce: ${consent.nonce}`,
    `Issued: ${new Date(consent.issuedAt).toISOString()}`,
    `Sign before: ${new Date(consent.signingExpiresAt).toISOString()}`,
    `Terms SHA-256: ${consent.termsHash}`,
    canonicalJson(consent.terms),
  ].join("\n");
}

// Pure preparation only: does not qualify a quote/route, reserve capacity,
// attest identity eligibility, issue payment instructions or authorize a worker.
export function createCommitmentConsent(
  origin: string,
  terms: ConsentTerms,
  now = Date.now(),
): CommitmentConsent {
  if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
    throw new Error("Consent requires the fixed HTTPS application origin");
  validateConsentTerms(terms, now);
  const value: Omit<CommitmentConsent, "message"> = {
    format: "showup.commitment.consent.v1",
    id: randomUUID(),
    origin,
    nonce: randomBytes(32).toString("base64"),
    issuedAt: now,
    signingExpiresAt: Math.min(now + 300_000, terms.authorizationExpiresAt),
    terms: structuredClone(terms),
    termsHash: canonicalHash(terms),
  };
  return { ...value, message: message(value) };
}

export function consentWalletMessage(consent: CommitmentConsent) {
  return {
    network: consent.terms.source.network,
    address: consent.terms.source.address,
    message: consent.message,
    nonce: consent.nonce,
    recipient: new URL(consent.origin).host,
    callbackUrl: `${consent.origin}/account/commitments?consent=${consent.id}`,
  };
}

// Cryptographic consent only. The caller must additionally bind the original
// server record/session, prove control of destinations and check NEAR FullAccess.
export function verifyCommitmentConsent(
  consent: CommitmentConsent,
  proof: WalletSignature,
  origin: string,
  now = Date.now(),
): boolean {
  try {
    exact(consent, "format,id,issuedAt,message,nonce,origin,signingExpiresAt,terms,termsHash");
    validateConsentTerms(consent.terms, consent.issuedAt);
    if (
      consent.format !== "showup.commitment.consent.v1" ||
      consent.origin !== origin ||
      new URL(origin).protocol !== "https:" ||
      new URL(origin).origin !== origin ||
      !uuid.test(consent.id) ||
      !Number.isSafeInteger(now) ||
      now < consent.issuedAt ||
      now >= consent.signingExpiresAt ||
      consent.signingExpiresAt !==
        Math.min(consent.issuedAt + 300_000, consent.terms.authorizationExpiresAt) ||
      Buffer.from(consent.nonce, "base64").length !== 32 ||
      Buffer.from(consent.nonce, "base64").toString("base64") !== consent.nonce ||
      consent.termsHash !== canonicalHash(consent.terms) ||
      consent.message !== message(consent)
    )
      return false;
    return verifyWalletMessageSignature(consentWalletMessage(consent), proof);
  } catch {
    return false;
  }
}

export function assessPayout(
  consent: CommitmentConsent,
  gross: string,
  actualFee: string,
  routeMinimum: string,
) {
  validateConsentTerms(consent.terms, consent.issuedAt);
  const amount = integerAmount(gross),
    fee = integerAmount(actualFee),
    minimum = integerAmount(routeMinimum);
  if (fee > integerAmount(consent.terms.withdrawalFeeMaximum))
    return { state: "approval_required" as const, gross, fee: actualFee, net: null };
  const net = amount - fee;
  if (
    minimum === 0n ||
    net <= 0n ||
    net < minimum ||
    net < integerAmount(consent.terms.payoutMinimum)
  )
    return { state: "recovery_required" as const, gross, fee: actualFee, net: null };
  return { state: "within_limits" as const, gross, fee: actualFee, net: net.toString() };
}
