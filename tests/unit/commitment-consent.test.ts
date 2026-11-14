import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import { consentTerms } from "../fixtures/consent";
import {
  assessPayout,
  consentWalletMessage,
  createCommitmentConsent,
  verifyCommitmentConsent,
} from "../../src/server/commitments/consent";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { requireFundingRoute } from "../../src/server/protocol/manifest";
import {
  createWalletChallenge,
  nearMessageDigest,
  verifyWalletSignature,
  type WalletSignature,
} from "../../src/server/wallets/proof";

const origin = "https://localhost:3443",
  now = Date.now();

test("financial consent signatures work across all four networks and cannot replace wallet-control proofs", async () => {
  for (const network of ["base", "ethereum", "near", "solana"] as const) {
    const evm = network === "base" || network === "ethereum" ? Wallet.createRandom() : undefined;
    const keys = generateKeyPairSync("ed25519");
    const publicKey = encodeBase58(
      Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url"),
    );
    const address = evm?.address ?? (network === "near" ? "fictional-wallet.near" : publicKey);
    const terms = consentTerms(network, address, now);
    const consent = createCommitmentConsent(origin, terms, now);
    const proof: WalletSignature = evm
      ? { signature: await evm.signMessage(consent.message) }
      : {
          signature: sign(
            null,
            network === "near"
              ? nearMessageDigest(consentWalletMessage(consent))
              : Buffer.from(consent.message),
            keys.privateKey,
          ).toString("base64"),
          ...(network === "near" ? { accountId: address, publicKey: `ed25519:${publicKey}` } : {}),
        };
    assert(verifyCommitmentConsent(consent, proof, origin, now));
    assert(verifyCommitmentConsent(consent, proof, origin, now + 299_999));
    assert.equal(verifyCommitmentConsent(consent, proof, origin, now + 300_000), false);
    assert.equal(verifyCommitmentConsent(consent, proof, origin, now - 1), false);
    assert.equal(verifyCommitmentConsent(consent, proof, "https://elsewhere.example", now), false);
    const control = createWalletChallenge(origin, network, address, now);
    assert.equal(verifyWalletSignature(control, proof, origin, now), false);
    const controlProof: WalletSignature = evm
      ? { signature: await evm.signMessage(control.message) }
      : {
          ...proof,
          signature: sign(
            null,
            network === "near" ? nearMessageDigest(control) : Buffer.from(control.message),
            keys.privateKey,
          ).toString("base64"),
        };
    assert.equal(verifyCommitmentConsent(consent, controlProof, origin, now), false);
    assert.throws(() => requireFundingRoute(network), /Funding disabled/);
    terms.payout.address = "mutated-after-preparation";
    assert(
      verifyCommitmentConsent(consent, proof, origin, now),
      "prepared consent owns a detached copy",
    );
    assert(consent.message.includes("platform fee is zero"));
    assert.equal(Object.hasOwn(consent, "funded"), false);
  }
});

test("a source signature binds every monetary, destination, expiry and deployment field even if an authority rewrites the hash", async () => {
  const wallet = Wallet.createRandom();
  const consent = createCommitmentConsent(origin, consentTerms("base", wallet.address, now), now);
  const proof = { signature: await wallet.signMessage(consent.message) };
  const changes: Record<string, unknown> = {
    environment: "testnet",
    manifest: "c".repeat(64),
    deployment: "changed-escrow.near",
    event: randomUUID(),
    rulesHash: "c".repeat(64),
    registration: randomUUID(),
    participant: randomUUID(),
    timeZone: "Pacific/Auckland",
    source: { ...consent.terms.source, address: Wallet.createRandom().address.toLowerCase() },
    refund: { ...consent.terms.refund, address: Wallet.createRandom().address.toLowerCase() },
    payout: { ...consent.terms.payout, address: Wallet.createRandom().address.toLowerCase() },
    inputAsset: { ...consent.terms.inputAsset, decimals: 18 },
    maximumInput: "5200000",
    principal: "6000000",
    sourceGasMaximum: "200000",
    routingFeeMaximum: "200000",
    withdrawalFeeMaximum: "60000",
    payoutMinimum: "2000000",
    quoteHash: "c".repeat(64),
    quoteExpiresAt: now + 910_000,
    registrationClosesAt: now + 1_900_000,
    authorizationExpiresAt: now + 800_000,
    reservationExpiresAt: now + 299_000,
  };
  for (const [field, value] of Object.entries(changes)) {
    const altered = structuredClone(consent);
    Object.assign(altered.terms, { [field]: value });
    altered.termsHash = canonicalHash(altered.terms);
    assert.equal(verifyCommitmentConsent(altered, proof, origin, now), false, field);
    // Model a compromised identity authority that also reconstructs a valid
    // message and hash for new terms, preserving the original challenge ID and
    // nonce. The original wallet signature must still reject that substitution.
    let fresh: ReturnType<typeof createCommitmentConsent>;
    try {
      fresh = createCommitmentConsent(origin, altered.terms, now);
    } catch {
      continue;
    } // Independently invalid terms already fail policy.
    fresh.message = fresh.message.replace(fresh.id, consent.id).replace(fresh.nonce, consent.nonce);
    fresh.id = consent.id;
    fresh.nonce = consent.nonce;
    assert.equal(
      verifyCommitmentConsent(fresh, proof, origin, now),
      false,
      `rewritten message: ${field}`,
    );
    if (field !== "source")
      assert(
        verifyCommitmentConsent(
          fresh,
          { signature: await wallet.signMessage(fresh.message) },
          origin,
          now,
        ),
        `fresh wallet approval: ${field}`,
      );
  }
  for (const [field, value] of Object.entries({
    id: randomUUID(),
    origin: "https://elsewhere.example",
    nonce: randomBytes(32).toString("base64"),
    issuedAt: now + 1,
    signingExpiresAt: now + 600_000,
    format: "showup.wallet.control.v1",
    message: consent.message + "\nChanged",
    extra: true,
  }))
    assert.equal(
      verifyCommitmentConsent({ ...consent, [field]: value }, proof, origin, now),
      false,
      field,
    );
  assert.equal(
    verifyCommitmentConsent(consent, { ...proof, accountId: "extra" }, origin, now),
    false,
  );
  const wrong = Wallet.createRandom();
  assert.equal(
    verifyCommitmentConsent(
      consent,
      { signature: await wrong.signMessage(consent.message) },
      origin,
      now,
    ),
    false,
  );
});

test("a newly signed mutation still cannot bypass chain, asset, amount, expiry, origin or net-payout policy", () => {
  const wallet = Wallet.createRandom();
  const terms = consentTerms("ethereum", wallet.address, now);
  for (const change of [
    { manifest: "c".repeat(64) },
    { principal: "2499999" },
    { maximumInput: "0" },
    { principal: "5.00" },
    { principal: "05000000" },
    { principal: (1n << 128n).toString() },
    { withdrawalFeeMaximum: "5000000" },
    { payoutMinimum: "0" },
    { payoutMinimum: "4950001" },
    { source: { ...terms.source, chainId: "11155111" } },
    { payout: { ...terms.payout, address: "0x" + "0".repeat(40) } },
    { refund: { ...terms.refund, network: "base", chainId: "8453" } },
    { inputAsset: { contract: "native", decimals: 18 } },
    { inputAsset: { contract: terms.inputAsset.contract, decimals: 18 } },
    { reservationExpiresAt: now + 300_001 },
    { authorizationExpiresAt: now },
    { quoteExpiresAt: now + 1 },
    { registrationClosesAt: now + 1 },
    { authorizationExpiresAt: now + 1_800_001, quoteExpiresAt: now + 2_000_000 },
    { timeZone: "Invented/Somewhere" },
    { extra: "not accepted" },
  ])
    assert.throws(() =>
      createCommitmentConsent(origin, { ...terms, ...change } as typeof terms, now),
    );
  for (const invalid of [
    "http://localhost:3443",
    origin + "/extra",
    "https://user:password@localhost:3443",
  ])
    assert.throws(() => createCommitmentConsent(invalid, terms, now));
  const nearClose = {
    ...terms,
    registrationClosesAt: now + 30_000,
    authorizationExpiresAt: now + 30_000,
    reservationExpiresAt: now + 30_000,
  };
  const consent = createCommitmentConsent(origin, nearClose, now);
  assert.equal(consent.signingExpiresAt, now + 30_000);
  assert.equal(consent.terms.reservationExpiresAt, now + 30_000);
});

test("authorized fees preserve gross accounting and pause over-cap or uneconomic delivery", () => {
  const consent = createCommitmentConsent(
    origin,
    consentTerms("base", Wallet.createRandom().address, now),
    now,
  );
  assert.deepEqual(assessPayout(consent, "5000000", "50000", "1000000"), {
    state: "within_limits",
    gross: "5000000",
    fee: "50000",
    net: "4950000",
  });
  for (const [gross, fee, minimum, state] of [
    ["5000000", "50001", "1000000", "approval_required"],
    ["40000", "50000", "1000000", "recovery_required"],
    ["50000", "50000", "1000000", "recovery_required"],
    ["5000000", "50000", "4950001", "recovery_required"],
    ["5000000", "50000", "0", "recovery_required"],
  ])
    assert.equal(assessPayout(consent, gross, fee, minimum).state, state);
  assert.equal(assessPayout(consent, "5000000", "0", "1000000").net, "5000000");
  assert.throws(() => assessPayout(consent, "-1", "0", "1000000"));
  assert.throws(() => assessPayout(consent, "5000000", "0.01", "1000000"));
  assert.equal(consent.terms.withdrawalFeeMaximum, "50000");
});
