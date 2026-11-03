import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import {
  createWalletChallenge,
  nearMessageDigest,
  verifyWalletSignature,
  walletAddress,
  type WalletSignature,
} from "../../src/server/wallets/proof";
import { requireNearFullAccess } from "../../src/server/wallets/near-access";

const origin = "https://localhost:3443";
const now = Date.now();

test("EVM control proofs bind the exact origin, chain, wallet, nonce, purpose and five-minute window", async () => {
  for (const network of ["base", "ethereum"] as const) {
    const wallet = Wallet.createRandom();
    const other = Wallet.createRandom();
    const challenge = createWalletChallenge(origin, network, wallet.address, now);
    const proof = { signature: await wallet.signMessage(challenge.message) };
    assert(verifyWalletSignature(challenge, proof, origin, now));
    assert(verifyWalletSignature(challenge, proof, origin, now + 299_999));
    assert.equal(verifyWalletSignature(challenge, proof, origin, now + 300_000), false);
    assert.equal(verifyWalletSignature(challenge, proof, origin, now - 1), false);
    assert.equal(verifyWalletSignature(challenge, proof, "https://evil.example", now), false);
    const changes = {
      origin: "https://evil.example",
      recipient: "evil.example",
      callbackUrl: "https://evil.example/return",
      network: network === "base" ? "ethereum" : "base",
      chainId: "84532",
      address: other.address.toLowerCase(),
      nonce: randomBytes(32).toString("base64"),
      message: challenge.message + "\nAuthorize a transfer",
      format: "showup.funding.authorization.v1",
      id: randomUUID(),
      expiresAt: now + 600_000,
      issuedAt: now + 1,
    };
    for (const [field, value] of Object.entries(changes))
      assert.equal(
        verifyWalletSignature({ ...challenge, [field]: value }, proof, origin, now),
        false,
        field,
      );
    assert.equal(
      verifyWalletSignature(
        challenge,
        { signature: await other.signMessage(challenge.message) },
        origin,
        now,
      ),
      false,
    );
    assert.equal(
      verifyWalletSignature(challenge, { ...proof, accountId: "unexpected" }, origin, now),
      false,
    );
    assert.equal(
      createWalletChallenge(origin, network, wallet.address, now).nonce === challenge.nonce,
      false,
    );
  }
});

test("NEP-413 serialization matches an independent Rust Borsh specification vector", () => {
  const example = {
    ...createWalletChallenge(origin, "near", "fictional-wallet.near", now),
    message: "hi",
    nonce: Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64"),
    recipient: "myapp.com",
    callbackUrl: "myapp.com/callback",
  };
  // Computed independently using Rust borsh 1.8.1 and sha2 0.10.9 for the
  // published NEP-413 example, including Option::Some(callbackUrl).
  assert.equal(
    nearMessageDigest(example).toString("hex"),
    "c9ce5de288f7de6d83e2303e56c7615949da83867ea33c0747ed45c47ef50148",
  );
});

test("Ed25519 proofs distinguish raw Solana messages from tagged NEAR hashes and reject unusable keys", () => {
  for (const network of ["near", "solana"] as const) {
    const keys = generateKeyPairSync("ed25519");
    const bytes = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url");
    const address = network === "near" ? "fictional-wallet.near" : encodeBase58(bytes);
    const challenge = createWalletChallenge(origin, network, address, now);
    const payload =
      network === "near" ? nearMessageDigest(challenge) : Buffer.from(challenge.message);
    const proof: WalletSignature = {
      signature: sign(null, payload, keys.privateKey).toString("base64"),
    };
    if (network === "near")
      Object.assign(proof, { accountId: address, publicKey: `ed25519:${encodeBase58(bytes)}` });
    assert(verifyWalletSignature(challenge, proof, origin, now));
    const wrongPayload =
      network === "near" ? Buffer.from(challenge.message) : nearMessageDigest(challenge);
    assert.equal(
      verifyWalletSignature(
        challenge,
        { ...proof, signature: sign(null, wrongPayload, keys.privateKey).toString("base64") },
        origin,
        now,
      ),
      false,
    );
    assert.equal(
      verifyWalletSignature(
        { ...challenge, callbackUrl: origin + "/elsewhere" },
        proof,
        origin,
        now,
      ),
      false,
    );
    assert.equal(
      verifyWalletSignature(
        challenge,
        { ...proof, signature: proof.signature.slice(0, -1) },
        origin,
        now,
      ),
      false,
    );
    assert.equal(
      verifyWalletSignature(
        challenge,
        { ...proof, accountId: "another-account.near" },
        origin,
        now,
      ),
      false,
    );
    assert.equal(verifyWalletSignature(challenge, proof, origin, now + 300_000), false);
  }
  const weak = Buffer.alloc(32);
  weak[0] = 1;
  const signature = Buffer.alloc(64);
  signature[0] = 1;
  const challenge = createWalletChallenge(origin, "solana", encodeBase58(weak), now);
  assert.equal(
    verifyWalletSignature(challenge, { signature: signature.toString("base64") }, origin, now),
    false,
  );
  assert.throws(() => createWalletChallenge("http://localhost:3443", "near", "fictional.near"));
  for (const address of ["a", "two..dots.near", "Mixed.near", "wrong/account", " space.near"])
    assert.throws(() => walletAddress("near", address));
});

test("NEAR wallet binding requires the same finalized FullAccess key at both fixed sources", async () => {
  const challenge = createWalletChallenge(origin, "near", "fictional-wallet.near");
  const proof = {
    signature: "unused-public-fixture",
    publicKey: `ed25519:${encodeBase58(randomBytes(32))}`,
    accountId: challenge.address,
  };
  const block = encodeBase58(Buffer.alloc(32, 7));
  let mode = "valid";
  let queries = 0;
  const transport: typeof fetch = async (url, options) => {
    const second = new URL(String(url)).hostname.includes("fastnear");
    const input = JSON.parse(String(options?.body));
    let result: unknown;
    if (input.method === "status")
      result = { chain_id: mode === "wrong-chain" ? "testnet" : "mainnet" };
    else if (input.method === "block")
      result = {
        header: {
          height: 100,
          hash: mode === "fork" && second ? encodeBase58(Buffer.alloc(32, 8)) : block,
          timestamp_nanosec: (BigInt(Date.now() - 1000) * 1_000_000n).toString(),
        },
      };
    else {
      queries++;
      assert.equal(input.method, "query");
      assert.equal(input.params.account_id, challenge.address);
      assert.equal(input.params.block_id, block);
      assert.equal(input.params.request_type, "view_access_key_list");
      result = {
        block_hash: mode === "wrong-bank" ? encodeBase58(Buffer.alloc(32, 8)) : block,
        block_height: 100,
        keys:
          mode === "missing" && second
            ? []
            : [
                {
                  public_key: proof.publicKey,
                  access_key: {
                    permission:
                      mode === "function-call"
                        ? { FunctionCall: { receiver_id: "fictional.near" } }
                        : "FullAccess",
                  },
                },
              ],
      };
    }
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  const accepted = await requireNearFullAccess(challenge, proof, transport);
  assert.equal(accepted.blockHash, block);
  assert.equal(queries, 2);
  for (const variant of ["missing", "function-call", "wrong-bank", "wrong-chain", "fork"]) {
    mode = variant;
    await assert.rejects(() => requireNearFullAccess(challenge, proof, transport), variant);
  }
});
