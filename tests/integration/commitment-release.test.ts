import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { hash } from "../../src/server/auth/crypto";
import { prepareCommitmentRelease } from "../../src/server/commitments/release";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { attendanceFixtures } from "../fixtures/attendance";
import { confirmedDeletion } from "../fixtures/deletion";

test("release keeps qualification and the strict deadline closed while preserving original-obligation recovery after deletion", async () => {
  const f = await attendanceFixtures();
  const input = { operationId: randomUUID(), consentId: f.consent.id, confirmRelease: true };
  const status = (code: number) => (error: unknown) =>
    error instanceof AppFailure && error.status === code;
  try {
    // This existing funded fixture starts in the past, so its release deadline is closed.
    await assert.rejects(
      prepareCommitmentRelease(f.pool, f.config, f.session, input, f.source),
      status(409),
    );
    const deletion = await requestAccountDeletion(
      f.pool,
      f.config,
      f.session,
      confirmedDeletion(f.config, f.accounts[0].id, f.session),
    );
    assert.equal(deletion.state, "pending_reconciliation");
    assert(deletion.sessionValue);
    const restricted = hash(deletion.sessionValue);
    // Restricted account auth remains valid for the original obligation; route
    // qualification, rather than loss of recovery identity, stops the request.
    await assert.rejects(
      prepareCommitmentRelease(f.pool, f.config, restricted, input),
      status(503),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM app_commitment_releases WHERE consent_id=$1",
          [f.consent.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
