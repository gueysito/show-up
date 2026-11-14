import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Wallet } from "ethers";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash, unseal } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { revokeSession } from "../../src/server/auth/sessions";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { AppFailure } from "../../src/server/http/security";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import {
  nearMessageDigest,
  type WalletChallenge,
  type WalletSignature,
} from "../../src/server/wallets/proof";
import {
  acceptWalletProof,
  issueWalletChallenge,
  listOwnWallets,
  removeOwnWallet,
} from "../../src/server/wallets/service";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Wallet checks require the disposable test database");
const { pool } = createDatabase();
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3443",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const accounts = new Set<string>();
const status = (expected: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === expected;
before(async () => {
  await migrate(pool);
  // Earlier fixture files share this disposable database and consume the global budget.
  await pool.query("DELETE FROM app_rate_limits WHERE key_hash=$1", [hash("wallet:global")]);
});
after(async () => {
  const ids = [...accounts];
  for (const table of [
    "app_wallet_challenges",
    "app_wallets",
    "app_mutations",
    "app_audit",
    "app_roles",
    "app_identities",
    "app_sessions",
  ])
    await pool.query(
      `DELETE FROM ${table} WHERE ${table === "app_audit" || table === "app_mutations" ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
      [ids],
    );
  await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});
async function login(subject = randomUUID()) {
  const result = await establishIdentity(pool, config, "telegram", {
    issuer: issuers.telegram,
    subject,
  });
  accounts.add(result.accountId);
  return { ...result, session: hash(result.value), subject };
}
function edWallet(network: "near" | "solana") {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = encodeBase58(
    Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url"),
  );
  const address = network === "near" ? "fictional-wallet.near" : publicKey;
  return {
    address,
    publicKey,
    sign(challenge: WalletChallenge): WalletSignature {
      return {
        signature: sign(
          null,
          network === "near" ? nearMessageDigest(challenge) : Buffer.from(challenge.message),
          keys.privateKey,
        ).toString("base64"),
        ...(network === "near" ? { publicKey: `ed25519:${publicKey}`, accountId: address } : {}),
      };
    },
  };
}
function nearSources(
  publicKey: string,
  permission: unknown = "FullAccess",
  disagree = false,
): typeof fetch {
  const timestamp = Date.now() - 1000,
    block = encodeBase58(Buffer.alloc(32, 7));
  return async (url, options) => {
    const input = JSON.parse(String(options?.body));
    const second = new URL(String(url)).hostname.includes("fastnear");
    const result =
      input.method === "status"
        ? { chain_id: "mainnet" }
        : input.method === "block"
          ? {
              header: {
                height: 100,
                hash: block,
                timestamp_nanosec: (BigInt(timestamp) * 1_000_000n).toString(),
              },
            }
          : {
              block_hash: block,
              block_height: 100,
              keys:
                disagree && second
                  ? []
                  : [{ public_key: `ed25519:${publicKey}`, access_key: { permission } }],
            };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
}

test("all four control-proof families persist encrypted own-wallet records without creating a funded seat", async () => {
  const actor = await login();
  const other = await login();
  for (const network of ["near", "base", "ethereum", "solana"] as const) {
    const evm = network === "base" || network === "ethereum" ? Wallet.createRandom() : undefined;
    const ed = network === "near" || network === "solana" ? edWallet(network) : undefined;
    const address = evm?.address ?? ed!.address;
    const challenge = await issueWalletChallenge(pool, config, actor.session, {
      operationId: randomUUID(),
      network,
      address,
    });
    const proof = evm
      ? { signature: await evm.signMessage(challenge.message) }
      : ed!.sign(challenge);
    const input = { operationId: randomUUID(), challengeId: challenge.id, proof };
    const wallet = await acceptWalletProof(
      pool,
      config,
      actor.session,
      input,
      nearSources(ed?.publicKey ?? "unused"),
    );
    assert.equal(wallet.network, network);
    assert.equal(wallet.address, challenge.address);
    assert.equal(Object.hasOwn(wallet, "funded"), false);
    assert.deepEqual(
      await acceptWalletProof(pool, config, actor.session, input),
      wallet,
      "An exact completed operation replays without another source read",
    );
    const stored = (await pool.query("SELECT * FROM app_wallets WHERE id=$1", [wallet.id])).rows[0];
    assert.equal(stored.encrypted_wallet.includes(challenge.address), false);
    assert.match(stored.wallet_index, /^[0-9a-f]{64}$/);
    const retained = unseal(
      config.encryptionKey,
      `wallet:${actor.accountId}:${wallet.id}`,
      stored.encrypted_wallet,
    ) as { proof: WalletSignature };
    assert.deepEqual(retained.proof, proof);
    const rawChallenge = (
      await pool.query("SELECT * FROM app_wallet_challenges WHERE id=$1", [challenge.id])
    ).rows[0];
    assert.equal(rawChallenge.encrypted_challenge.includes(challenge.address), false);
    assert(rawChallenge.consumed_at);
  }
  assert.equal((await listOwnWallets(pool, config, actor.accountId)).length, 4);
  assert.deepEqual(await listOwnWallets(pool, config, other.accountId), []);
});

test("concurrent proof consumption accepts once and exact transport replay preserves the same record", async () => {
  const actor = await login(),
    wallet = Wallet.createRandom();
  const challenge = await issueWalletChallenge(pool, config, actor.session, {
    operationId: randomUUID(),
    network: "base",
    address: wallet.address,
  });
  const proof = { signature: await wallet.signMessage(challenge.message) };
  const attempts = [0, 1].map(() => ({
    operationId: randomUUID(),
    challengeId: challenge.id,
    proof,
  }));
  const outcomes = await Promise.allSettled(
    attempts.map((input) => acceptWalletProof(pool, config, actor.session, input)),
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    outcomes.filter((result) => result.status === "rejected" && status(409)(result.reason)).length,
    1,
  );
  const accepted = outcomes.findIndex((result) => result.status === "fulfilled");
  const repeated = await acceptWalletProof(pool, config, actor.session, attempts[accepted]);
  assert.equal((await listOwnWallets(pool, config, actor.accountId))[0].id, repeated.id);
  assert.equal(
    (
      await pool.query("SELECT count(*)::int AS n FROM app_wallets WHERE account_id=$1", [
        actor.accountId,
      ])
    ).rows[0].n,
    1,
  );
});

test("account/session swaps and changed messages cannot redeem another wallet authorization", async () => {
  const actor = await login(),
    other = await login(),
    anotherSession = await login(actor.subject);
  const wallet = Wallet.createRandom();
  const challenge = await issueWalletChallenge(pool, config, actor.session, {
    operationId: randomUUID(),
    network: "ethereum",
    address: wallet.address,
  });
  const proof = { signature: await wallet.signMessage(challenge.message) };
  for (const session of [other.session, anotherSession.session])
    await assert.rejects(
      () =>
        acceptWalletProof(pool, config, session, {
          operationId: randomUUID(),
          challengeId: challenge.id,
          proof,
        }),
      status(404),
    );
  for (const text of [
    challenge.message.replace("localhost:3443", "evil.example"),
    challenge.message + "\nDestination: another wallet",
  ]) {
    const altered = { signature: await wallet.signMessage(text) };
    await assert.rejects(
      () =>
        acceptWalletProof(pool, config, actor.session, {
          operationId: randomUUID(),
          challengeId: challenge.id,
          proof: altered,
        }),
      status(400),
    );
  }
  assert.equal(
    (await pool.query("SELECT consumed_at FROM app_wallet_challenges WHERE id=$1", [challenge.id]))
      .rows[0].consumed_at,
    null,
  );
  await acceptWalletProof(pool, config, actor.session, {
    operationId: randomUUID(),
    challengeId: challenge.id,
    proof,
  });
  assert.equal((await listOwnWallets(pool, config, other.accountId)).length, 0);
});

test("removal is account scoped and only a fresh challenge can restore the selected wallet", async () => {
  const actor = await login(),
    other = await login();
  const wallet = edWallet("solana"),
    keep = edWallet("solana");
  const challengeFor = (address: string) =>
    issueWalletChallenge(pool, config, actor.session, {
      operationId: randomUUID(),
      network: "solana",
      address,
    });
  const prove = (challenge: WalletChallenge, signer: typeof wallet) =>
    acceptWalletProof(pool, config, actor.session, {
      operationId: randomUUID(),
      challengeId: challenge.id,
      proof: signer.sign(challenge),
    });
  const removed = await prove(await challengeFor(wallet.address), wallet);
  const retained = await prove(await challengeFor(keep.address), keep);
  const stale = await challengeFor(wallet.address);
  const removal = { walletId: removed.id, operationId: randomUUID() };
  await assert.rejects(removeOwnWallet(pool, config, other.session, removal), status(404));
  assert.deepEqual(await removeOwnWallet(pool, config, actor.session, removal), {
    walletId: removed.id,
  });
  assert.deepEqual(await listOwnWallets(pool, config, actor.accountId), [retained]);
  await assert.rejects(prove(stale, wallet), status(409));
  const restored = await prove(await challengeFor(wallet.address), wallet);
  assert.equal(restored.id, removed.id);
  await removeOwnWallet(pool, config, actor.session, removal);
  assert.deepEqual(
    new Set((await listOwnWallets(pool, config, actor.accountId)).map(({ id }) => id)),
    new Set([retained.id, restored.id]),
  );
});

test("expiry and session revocation prevent proof acceptance without leaving a verified record", async () => {
  const actor = await login(),
    wallet = edWallet("solana");
  const challenge = await issueWalletChallenge(pool, config, actor.session, {
    operationId: randomUUID(),
    network: "solana",
    address: wallet.address,
  });
  await pool.query(
    "UPDATE app_wallet_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [challenge.id],
  );
  await assert.rejects(
    () =>
      acceptWalletProof(pool, config, actor.session, {
        operationId: randomUUID(),
        challengeId: challenge.id,
        proof: wallet.sign(challenge),
      }),
    status(409),
  );
  await revokeSession(pool, { accountId: actor.accountId, tokenHash: actor.session, roles: [] });
  await assert.rejects(
    () =>
      issueWalletChallenge(pool, config, actor.session, {
        operationId: randomUUID(),
        network: "solana",
        address: wallet.address,
      }),
    status(401),
  );
  assert.deepEqual(await listOwnWallets(pool, config, actor.accountId), []);
});

test("a NEAR signature alone cannot bypass FullAccess or conflicting finalized membership checks", async () => {
  const actor = await login(),
    wallet = edWallet("near");
  const challenge = await issueWalletChallenge(pool, config, actor.session, {
    operationId: randomUUID(),
    network: "near",
    address: wallet.address,
  });
  const input = {
    operationId: randomUUID(),
    challengeId: challenge.id,
    proof: wallet.sign(challenge),
  };
  await assert.rejects(
    () =>
      acceptWalletProof(
        pool,
        config,
        actor.session,
        input,
        nearSources(wallet.publicKey, { FunctionCall: { receiver_id: "fictional.near" } }),
      ),
    status(403),
  );
  await assert.rejects(
    () =>
      acceptWalletProof(
        pool,
        config,
        actor.session,
        input,
        nearSources(wallet.publicKey, "FullAccess", true),
      ),
    status(503),
  );
  assert.deepEqual(await listOwnWallets(pool, config, actor.accountId), []);
  const accepted = await acceptWalletProof(
    pool,
    config,
    actor.session,
    input,
    nearSources(wallet.publicKey),
  );
  assert.equal(accepted.address, wallet.address);
});

test("authenticated challenge issuance has an account-wide limit shared by sessions", async () => {
  const actor = await login(),
    second = await login(actor.subject),
    wallet = Wallet.createRandom();
  for (let index = 0; index < 6; index++)
    await issueWalletChallenge(pool, config, index % 2 ? actor.session : second.session, {
      operationId: randomUUID(),
      network: "base",
      address: wallet.address,
    });
  await assert.rejects(
    () =>
      issueWalletChallenge(pool, config, actor.session, {
        operationId: randomUUID(),
        network: "base",
        address: wallet.address,
      }),
    status(429),
  );
});

test("wallet schema changes roll back transactionally without changing the account tables", async () => {
  const client = await pool.connect(),
    schema = `wallet_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query(await readFile("migrations/005-wallet-control.sql", "utf8"));
    assert(
      (await client.query("SELECT to_regclass($1) AS relation", [`${schema}.app_wallets`])).rows[0]
        .relation,
    );
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
    assert(
      (await client.query("SELECT to_regclass('public.app_accounts') AS relation")).rows[0]
        .relation,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
