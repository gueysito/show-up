import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import { consentTerms } from "../fixtures/consent";
import {
  contractAuthorization,
  contractReference,
} from "../../src/server/commitments/contract-authorization";
import {
  consentWalletMessage,
  createCommitmentConsent,
  verifyCommitmentConsent,
  type SandboxConsentProfile,
} from "../../src/server/commitments/consent";
import { canonicalJson } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { nearMessageDigest, type WalletSignature } from "../../src/server/wallets/proof";

const origin = "https://localhost:3443",
  now = Date.now();
test("contract wire binds the complete approved consent, canonical references, destinations, fee cap and expiries on every family", async () => {
  for (const network of ["near", "base", "ethereum", "solana"] as const) {
    const evm = network === "base" || network === "ethereum" ? Wallet.createRandom() : undefined;
    const key = generateKeyPairSync("ed25519"),
      publicKey = encodeBase58(
        Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url"),
      );
    const address = evm?.address ?? (network === "near" ? "fictional-wallet.near" : publicKey);
    const terms = consentTerms(network, address, now),
      consent = createCommitmentConsent(origin, terms, now);
    const proof: WalletSignature = evm
      ? { signature: await evm.signMessage(consent.message) }
      : {
          signature: sign(
            null,
            network === "near"
              ? nearMessageDigest(consentWalletMessage(consent))
              : Buffer.from(consent.message),
            key.privateKey,
          ).toString("base64"),
          ...(network === "near" ? { accountId: address, publicKey: `ed25519:${publicKey}` } : {}),
        };
    const wire = contractAuthorization(origin, consent, proof, now + 1000),
      auth = wire.authorization;
    assert.equal(wire.fundingAllowed, false);
    assert.equal(auth.event, contractReference(terms.event));
    assert.equal(auth.registration, contractReference(terms.registration));
    assert.equal(auth.participant, contractReference(terms.participant));
    assert.equal(auth.principal, terms.principal);
    assert.equal(auth.fee_cap, terms.withdrawalFeeMaximum);
    assert.equal(auth.source.address, terms.source.address);
    assert.equal(auth.source.asset, terms.inputAsset.contract);
    assert.equal(auth.refund.address, terms.refund.address);
    assert.equal(auth.payout.address, terms.payout.address);
    assert.equal(auth.expires_ms, terms.authorizationExpiresAt);
    assert.equal(auth.reservation_ms, terms.reservationExpiresAt);
    assert.equal(auth.wallet_consent, canonicalJson({ consent, proof, acceptedAt: now + 1000 }));
    assert.throws(() =>
      contractAuthorization("https://elsewhere.example", consent, proof, now + 1000),
    );
    assert.throws(() => contractAuthorization(origin, consent, proof, now + 300_000));
    assert.throws(() =>
      contractAuthorization(
        origin,
        { ...consent, terms: { ...terms, withdrawalFeeMaximum: "60000" } },
        proof,
        now + 1000,
      ),
    );
  }
  assert.equal(contractReference("00000000-0000-0000-0000-000000000001"), "0".repeat(63) + "1");
  for (const malformed of ["1", randomUUID().toUpperCase(), "0".repeat(64)])
    assert.throws(() => contractReference(malformed));
});

test("the same EVM funding wallet has one event tag across Base and Ethereum and input asset aliases", async () => {
  const wallet = Wallet.createRandom(),
    event = randomUUID();
  const tags = [];
  for (const network of ["base", "ethereum"] as const) {
    const terms = { ...consentTerms(network, wallet.address, now), event };
    const consent = createCommitmentConsent(origin, terms, now);
    tags.push(
      contractAuthorization(
        origin,
        consent,
        { signature: await wallet.signMessage(consent.message) },
        now,
      ).authorization.wallet_tag,
    );
  }
  assert.equal(tags[0], tags[1]);
  const terms = {
    ...consentTerms("base", wallet.address, now),
    event,
    inputAsset: { contract: "native", decimals: 18 },
    maximumInput: "100000000000000000",
  };
  const consent = createCommitmentConsent(origin, terms, now);
  assert.equal(
    contractAuthorization(
      origin,
      consent,
      { signature: await wallet.signMessage(consent.message) },
      now,
    ).authorization.wallet_tag,
    tags[0],
  );
});

test("sandbox consent needs an explicit trusted profile, identifies disposable tokens and cannot validate on the default app path", () => {
  const key = generateKeyPairSync("ed25519"),
    publicKey = encodeBase58(Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url"));
  const profile: SandboxConsentProfile = {
    environment: "sandbox",
    manifest: "local-v1",
    token: "fictional-sandbox-usdc.near",
  };
  const terms = consentTerms("near", "fictional-wallet.near", now);
  terms.environment = "sandbox";
  terms.manifest = profile.manifest;
  terms.inputAsset.contract = profile.token;
  for (const selected of [terms.source, terms.refund, terms.payout]) selected.chainId = "sandbox";
  assert.throws(() => createCommitmentConsent(origin, terms, now));
  const consent = createCommitmentConsent(origin, terms, now, profile);
  assert(consent.message.includes("DISPOSABLE SANDBOX TOKENS ONLY"));
  const proof = {
    accountId: terms.source.address,
    publicKey: `ed25519:${publicKey}`,
    signature: sign(
      null,
      nearMessageDigest(consentWalletMessage(consent)),
      key.privateKey,
    ).toString("base64"),
  };
  assert.equal(verifyCommitmentConsent(consent, proof, origin, now), false);
  assert(verifyCommitmentConsent(consent, proof, origin, now, profile));
  assert.throws(() => contractAuthorization(origin, consent, proof, now));
  const wire = contractAuthorization(origin, consent, proof, now, profile);
  assert.equal(wire.authorization.source.asset, profile.token);
  assert.equal(wire.authorization.refund.asset, profile.token);
  assert.equal(wire.authorization.domain, "showup.sandbox.authorization.v1");
  assert.equal(wire.fundingAllowed, false);
  for (const changed of [
    { ...profile, token: "lookalike.near" },
    { ...profile, manifest: "changed-v1" },
  ])
    assert.equal(verifyCommitmentConsent(consent, proof, origin, now, changed), false);
});
