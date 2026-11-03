import type pg from "pg";
import { unseal } from "../auth/crypto";
import { transaction } from "../db/client";

const sevenDays = 7 * 86400_000;
// Control challenges are independent of event money. Their nonce can be retired
// seven days after expiry. Financial originals and obligations are never touched.
export function controlReceiptDeadline(value: unknown): Date | null {
  if (!value || typeof value !== "object") return null;
  const challenge = value as { format?: unknown; expiresAt?: unknown; issuedAt?: unknown };
  if (
    challenge.format !== "showup.wallet.control.v1" ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    !Number.isSafeInteger(challenge.issuedAt) ||
    Number(challenge.expiresAt) !== Number(challenge.issuedAt) + 300_000
  )
    return null;
  const deadline = new Date(Number(challenge.expiresAt) + sevenDays);
  return Number.isFinite(deadline.getTime()) ? deadline : null;
}

export async function retirePrivacyRecords(
  pool: pg.Pool,
  encryptionKey?: string,
  batchSize = 100,
  testClock?: Date,
) {
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 500 ||
    (encryptionKey !== undefined && !/^[0-9a-f]{64}$/.test(encryptionKey))
  )
    throw new Error("Invalid privacy maintenance configuration");
  if (testClock && (process.env.SHOWUP_ENV !== "test" || !Number.isFinite(testClock.getTime())))
    throw new Error("A simulated retention clock requires the disposable test environment");
  return transaction(pool, async (client) => {
    const now =
      testClock?.toISOString() ??
      ((await client.query("SELECT clock_timestamp()::text AS current_time")).rows[0]
        .current_time as string);
    const audit = await client.query(
      `WITH expired AS (SELECT id FROM app_audit WHERE created_at<=$1::timestamptz-interval '90 days' ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM app_audit WHERE id IN (SELECT id FROM expired)`,
      [now, batchSize],
    );
    await client.query(
      `WITH expired AS (SELECT account_id FROM app_telegram_connection_attempts WHERE expires_at<=$1::timestamptz-interval '7 days'
       ORDER BY expires_at,account_id LIMIT $2 FOR UPDATE SKIP LOCKED)
       DELETE FROM app_telegram_connection_attempts WHERE account_id IN (SELECT account_id FROM expired)`,
      [now, batchSize],
    );
    const challenges = await client.query(
      `WITH expired AS (SELECT id FROM app_wallet_challenges WHERE expires_at<=$1::timestamptz-interval '7 days' ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM app_wallet_challenges WHERE id IN (SELECT id FROM expired)`,
      [now, batchSize],
    );
    const completed = await client.query(
      `WITH expired AS (SELECT account_id FROM app_deletion_requests WHERE completed_at<=$1::timestamptz-interval '90 days' ORDER BY completed_at,account_id LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM app_deletion_requests WHERE account_id IN (SELECT account_id FROM expired)`,
      [now, batchSize],
    );
    const intakes = await client.query(
      `WITH expired AS (SELECT id FROM app_attendance_intakes
      WHERE completed_at<=$1::timestamptz-interval '90 days' ORDER BY completed_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
      DELETE FROM app_attendance_intakes WHERE id IN (SELECT id FROM expired)`,
      [now, batchSize],
    );
    const rows = (
      await client.query(
        `SELECT * FROM app_mutations WHERE payload_retired_at IS NULL AND
      (payload_expires_at<=$1::timestamptz OR (payload_expires_at IS NULL AND created_at<=$1::timestamptz-$3::int*interval '1 day'))
      ORDER BY COALESCE(payload_expires_at,created_at+interval '7 days'),operation_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, batchSize, encryptionKey ? 7 : 90],
      )
    ).rows;
    let payloads = 0,
      classified = 0;
    for (const row of rows) {
      if (row.payload_expires_at === null) {
        const value = encryptionKey
          ? unseal(
              encryptionKey,
              `mutation:${row.actor_id}:${row.operation_id}`,
              row.encrypted_receipt,
            )
          : null;
        const control = encryptionKey ? controlReceiptDeadline(value) : null;
        await client.query(
          "UPDATE app_mutations SET payload_expires_at=COALESCE($2::timestamptz,created_at+interval '90 days') WHERE operation_id=$1",
          [row.operation_id, control?.toISOString() ?? null],
        );
        classified++;
      }
      payloads +=
        (
          await client.query(
            `UPDATE app_mutations SET encrypted_receipt='',payload_retired_at=$2::timestamptz
        WHERE operation_id=$1 AND payload_expires_at<=$2::timestamptz AND payload_retired_at IS NULL`,
            [row.operation_id, now],
          )
        ).rowCount ?? 0;
    }
    const legacyNeedsKey =
      !encryptionKey &&
      Boolean(
        (
          await client.query(
            `SELECT 1 FROM app_mutations WHERE payload_retired_at IS NULL AND payload_expires_at IS NULL
      AND created_at<=$1::timestamptz-interval '7 days' AND created_at>$1::timestamptz-interval '90 days' LIMIT 1`,
            [now],
          )
        ).rowCount,
      );
    return {
      audit: audit.rowCount ?? 0,
      challenges: challenges.rowCount ?? 0,
      completedRequests: completed.rowCount ?? 0,
      intakes: intakes.rowCount ?? 0,
      payloads,
      classified,
      legacyNeedsKey,
    };
  });
}
