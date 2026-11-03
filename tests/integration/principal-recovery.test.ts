import { principalProcess } from "../../scripts/attendance-delivery-peer";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { attendanceFixtures } from "../fixtures/attendance";
import {
  runSandboxPrincipalRecovery,
  type SandboxPrincipalGateway,
} from "../../src/worker/principal-recovery";
import { unseal, hash } from "../../src/server/auth/crypto";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { AppFailure } from "../../src/server/http/security";
import { exportOwnData } from "../../src/server/privacy/export";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { confirmedDeletion } from "../fixtures/deletion";

const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
async function fixture() {
  const f = await attendanceFixtures();
  let current = structuredClone(f.source),
    submissions = 0;
  function advance() {
    const height = BigInt(current.block.height) + 1n;
    current.block = {
      height: height.toString(),
      hash: encodeBase58(Buffer.alloc(32, Number(height % 250n))),
      timestampMs: current.block.timestampMs + 1,
    };
  }
  function owe() {
    (current.views.event as { status: string }).status = "aborted";
    (current.views.registration as { state: string }).state = "refund_owed";
    current.views.principal = {
      total: "5000000",
      paid: "0",
      attempts: 0,
      pending: null,
      destination: current.context.authorization.payout,
    };
    current.views.accounting = {
      received: "5000000",
      delivered: "0",
      owed: "5000000",
      unallocated: "0",
    };
    advance();
  }
  function pay() {
    const liability = current.views.principal as {
      paid: string;
      attempts: number | bigint;
      pending: unknown;
    };
    liability.attempts = BigInt(liability.attempts) + 1n;
    liability.paid = "5000000";
    liability.pending = null;
    current.views.accounting = {
      received: "5000000",
      delivered: "5000000",
      owed: "0",
      unallocated: "0",
    };
    current.views.tokenBalance = "0";
    advance();
  }
  const gateway: SandboxPrincipalGateway = {
    context: f.source.context,
    read: async () => structuredClone(current),
    submit: async (id) => {
      assert.equal(id, `${f.source.context.authorization.registration}:principal`);
      submissions++;
      pay();
    },
  };
  return {
    ...f,
    owe,
    pay,
    advance,
    gateway,
    source: () => current,
    setSource: (value: typeof current) => {
      current = value;
    },
    counts: () => ({ submissions }),
    run: (adapter = gateway) =>
      runSandboxPrincipalRecovery(f.pool, f.config, f.consent.id, adapter),
    row: async () =>
      (
        await f.pool.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
          f.consent.id,
        ])
      ).rows[0],
  };
}

test("principal recovery uses only the original approved liability and persists its request before transfer", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).status, "awaiting_liability");
    assert.equal(f.counts().submissions, 0);
    f.owe();
    const submit = f.gateway.submit;
    f.gateway.submit = async (...args) => {
      const row = await f.row();
      assert.equal(row.state, "broadcast_unknown");
      assert.equal(row.submitted_attempt, "1");
      const request = unseal(
        f.config.encryptionKey,
        `principal-recovery:${f.consent.id}`,
        row.encrypted_request,
      ) as { liabilityId: string };
      assert.equal(request.liabilityId, args[0]);
      await submit(...args);
    };
    const before = await f.row();
    const result = await f.run();
    assert.equal(result.status, "observed");
    assert.equal(result.paymentConfirmed, false);
    assert.deepEqual(await f.run(), result);
    assert.equal((await f.row()).encrypted_request, before.encrypted_request);
    assert.equal(f.counts().submissions, 1);
  } finally {
    await f.cleanup();
  }
});

test("a lost transfer acknowledgement recovers paid state without repeating the original withdrawal", async () => {
  const f = await fixture();
  try {
    f.owe();
    const submit = f.gateway.submit;
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          submit: async (...args) => {
            await submit(...args);
            throw new Error("Lost acknowledgement");
          },
        })
      ).status,
      "broadcast_unknown",
    );
    const row = await f.row();
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          submit: async () => {
            throw new Error("No duplicate payment");
          },
        })
      ).status,
      "observed",
    );
    assert.equal((await f.row()).encrypted_request, row.encrypted_request);
    assert.equal(f.counts().submissions, 1);
  } finally {
    await f.cleanup();
  }
});

test("unknown submission with unchanged source never blindly resends, even from a later block", async () => {
  const f = await fixture();
  try {
    f.owe();
    let calls = 0;
    const gateway = {
      ...f.gateway,
      submit: async () => {
        calls++;
      },
    };
    assert.equal((await f.run(gateway)).status, "broadcast_unknown");
    f.advance();
    assert.equal((await f.run(gateway)).status, "broadcast_unknown");
    assert.equal(calls, 1);
    assert.equal((await f.row()).submitted_attempt, "1");
  } finally {
    await f.cleanup();
  }
});

test("pending callbacks prevent another transfer; an observed failed callback permits retry at the same liability", async () => {
  const f = await fixture();
  try {
    f.owe();
    let calls = 0;
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          submit: async () => {
            calls++;
            const value = f.source().views.principal as { attempts: number; pending: unknown };
            value.attempts = 1;
            value.pending = { number: 1, amount: "5000000" };
            f.advance();
          },
        })
      ).status,
      "pending_transfer",
    );
    assert.equal((await f.run()).status, "pending_transfer");
    assert.equal(f.counts().submissions, 0);
    (f.source().views.principal as { pending: null }).pending = null;
    f.advance();
    assert.equal((await f.run()).status, "observed");
    assert.equal((await f.row()).submitted_attempt, "2");
    assert.equal(calls, 1);
    assert.equal(f.counts().submissions, 1);
  } finally {
    await f.cleanup();
  }
});

test("partial paid principal retries only remaining contract debt, and an already-paid liability creates no transfer", async () => {
  for (const paid of ["2000000", "5000000"]) {
    const f = await fixture();
    try {
      f.owe();
      const value = f.source().views.principal as { paid: string; attempts: number };
      value.paid = paid;
      value.attempts = 1;
      const remaining = (5000000n - BigInt(paid)).toString();
      f.source().views.accounting = {
        received: "5000000",
        delivered: paid,
        owed: remaining,
        unallocated: "0",
      };
      f.source().views.tokenBalance = remaining;
      assert.equal((await f.run()).status, "observed");
      assert.equal(f.counts().submissions, paid === "5000000" ? 0 : 1);
    } finally {
      await f.cleanup();
    }
  }
});

test("source failures remain retryable, while fork, changed payout and regressing attempt evidence latch conflicts", async () => {
  for (const failure of ["fork", "payout", "attempt"]) {
    const f = await fixture();
    try {
      f.owe();
      (f.source().views.principal as { attempts: number; pending: unknown }).attempts = 1;
      (f.source().views.principal as { pending: unknown }).pending = {
        number: 1,
        amount: "5000000",
      };
      assert.equal((await f.run()).status, "pending_transfer");
      assert.equal(
        (
          await f.run({
            ...f.gateway,
            read: async () => {
              throw new Error("Source unavailable");
            },
          })
        ).status,
        "unavailable",
      );
      const next = structuredClone(f.source());
      if (failure === "fork") next.block.hash = encodeBase58(Buffer.alloc(32, 13));
      if (failure === "payout")
        (next.views.principal as { destination: unknown }).destination = {
          network: "near",
          asset: next.context.token,
          address: "another-wallet.near",
        };
      if (failure === "attempt") {
        (next.views.principal as { attempts: number; pending: unknown }).attempts = 0;
        (next.views.principal as { pending: unknown }).pending = null;
        next.block.height = "102";
      }
      f.setSource(next);
      assert.equal((await f.run()).status, "conflict");
      assert.equal((await f.run()).status, "conflict");
      assert.equal(f.counts().submissions, 0);
    } finally {
      await f.cleanup();
    }
  }
});

test("nonlocal, changed authorization and other-consent profiles cannot start principal recovery", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runSandboxPrincipalRecovery(
        f.pool,
        { ...f.config, origin: "https://other.invalid" },
        f.consent.id,
        f.gateway,
      ),
      status(409),
    );
    const changed = structuredClone(f.gateway.context);
    (changed.authorization.payout as { address: string }).address = "other-wallet.near";
    await assert.rejects(f.run({ ...f.gateway, context: changed }), status(409));
    await assert.rejects(
      runSandboxPrincipalRecovery(f.pool, f.config, randomUUID(), f.gateway),
      status(404),
    );
    assert.equal(await f.row(), undefined);
    assert.equal(f.counts().submissions, 0);
  } finally {
    await f.cleanup();
  }
});

test("principal-recovery migration rolls back and rejects partial claims and unobserved completion", async () => {
  const f = await fixture(),
    client = await f.pool.connect(),
    schema = `principal_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_commitment_consents(id uuid PRIMARY KEY)");
    await client.query(await readFile("migrations/021-principal-recovery.sql", "utf8"));
    await client.query("INSERT INTO app_commitment_consents VALUES($1)", [f.consent.id]);
    for (const field of ["claim_token", "state"]) {
      await client.query("SAVEPOINT invalid");
      await assert.rejects(
        client.query(
          `INSERT INTO app_principal_recoveries(consent_id,request_hash,encrypted_request,${field}) VALUES($1,$2,'opaque',$3)`,
          [f.consent.id, "a".repeat(64), field === "state" ? "observed" : randomUUID()],
        ),
        (error) => (error as { code: string }).code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid");
    }
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await f.cleanup();
  }
});

test("a killed principal process restarts from observed payment and preserves the original immutable request", async () => {
  const f = await fixture();
  try {
    f.owe();
    assert.equal((await principalProcess(f.config, f.consent.id, f.gateway, true)).killed, true);
    const before = await f.row();
    assert.equal(before.state, "broadcast_unknown");
    await f.pool.query(
      "UPDATE app_principal_recoveries SET claim_until=clock_timestamp()-interval '1 second' WHERE consent_id=$1",
      [f.consent.id],
    );
    assert.equal(
      (
        await principalProcess(f.config, f.consent.id, {
          ...f.gateway,
          submit: async () => {
            throw new Error("No repeated withdrawal");
          },
        })
      ).status,
      "observed",
    );
    const after = await f.row();
    assert.equal(after.encrypted_request, before.encrypted_request);
    assert.equal(after.request_hash, before.request_hash);
    assert.equal(after.attempts, 2);
    assert.equal(f.counts().submissions, 1);
  } finally {
    await f.cleanup();
  }
});

test("a principal process preserves full-u64 attempts and refuses overflow before any withdrawal", async () => {
  const f = await fixture();
  try {
    f.owe();
    (f.source().views.principal as { attempts: bigint }).attempts = 18446744073709551615n;
    assert.equal((await principalProcess(f.config, f.consent.id, f.gateway)).status, "conflict");
    assert.equal((await f.row()).last_error, "attempt_limit");
    assert.equal(f.counts().submissions, 0);
  } finally {
    await f.cleanup();
  }
});

test("held claims prevent competing principal work and an expired claimant cannot replace its successor's outcome", async () => {
  const f = await fixture();
  let release: () => void = () => {},
    started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  let first: Promise<unknown> | undefined;
  try {
    f.owe();
    let wait = true;
    first = f.run({
      ...f.gateway,
      read: async (signal) => {
        if (wait) {
          wait = false;
          started();
          await blocked;
        }
        return f.gateway.read(signal);
      },
    });
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error("Claimant exited before source read");
      }),
    ]);
    assert.equal((await f.run()).status, "processing");
    await f.pool.query(
      "UPDATE app_principal_recoveries SET claim_until=clock_timestamp()-interval '1 second' WHERE consent_id=$1",
      [f.consent.id],
    );
    assert.equal((await f.run()).status, "observed");
    const before = await f.row();
    release();
    await first;
    assert.equal((await f.row()).state, "observed");
    assert.equal((await f.row()).encrypted_request, before.encrypted_request);
    assert.equal(f.counts().submissions, 1);
  } finally {
    release();
    await first;
    await f.cleanup();
  }
});

test("restricted deletion recovery honors original principal obligations and exports only owned metadata", async () => {
  const f = await fixture();
  try {
    const original = (
      await f.pool.query(
        "SELECT consent_hash,encrypted_consent,encrypted_proof FROM app_commitment_consents WHERE id=$1",
        [f.consent.id],
      )
    ).rows[0];
    const deleted = await requestAccountDeletion(
      f.pool,
      f.config,
      f.session,
      confirmedDeletion(f.config, f.accounts[0].id, f.session),
    );
    assert.equal(deleted.state, "pending_reconciliation");
    f.owe();
    assert.equal((await f.run()).status, "observed");
    const owned = await exportOwnData(f.pool, f.config, hash(deleted.sessionValue!));
    const host = await exportOwnData(f.pool, f.config, hash(f.accounts[1].value));
    assert.equal(owned.principalRecoveries.length, 1);
    assert.equal(host.principalRecoveries.length, 0);
    assert.deepEqual(Object.keys(owned.principalRecoveries[0]).sort(), [
      "attempts",
      "consent_id",
      "last_error",
      "observed_hash",
      "observed_height",
      "state",
      "submitted_attempt",
    ]);
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT consent_hash,encrypted_consent,encrypted_proof FROM app_commitment_consents WHERE id=$1",
          [f.consent.id],
        )
      ).rows[0],
      original,
    );
  } finally {
    await f.cleanup();
  }
});

test("a stored status cannot claim principal completion without a matching paid source observation", async () => {
  const f = await fixture();
  try {
    f.owe();
    assert.equal(
      (await f.run({ ...f.gateway, submit: async () => {} })).status,
      "broadcast_unknown",
    );
    await f.pool.query("UPDATE app_principal_recoveries SET state='observed' WHERE consent_id=$1", [
      f.consent.id,
    ]);
    await assert.rejects(f.run(), /lacks observed payment/);
    assert.equal(f.counts().submissions, 0);
  } finally {
    await f.cleanup();
  }
});
