import type pg from "pg";
// All three queues use one owner nonce. After an unknown write, reconcile that
// original image before preparing anything in another queue.
export async function v1QueueAdmitted(
  pool: pg.Pool,
  queue: "publication" | "registration" | "action",
) {
  const pending = (
    await pool.query(`SELECT queue FROM (
    SELECT 'publication' AS queue,created_at FROM app_publication_images WHERE environment='near-mainnet-v1' AND transaction_state IN ('prepared','submitted')
    UNION ALL SELECT 'registration',created_at FROM app_v1_registrations WHERE state IN ('prepared','submitted')
    UNION ALL SELECT 'action',created_at FROM app_v1_event_actions WHERE state IN ('prepared','submitted')
  ) pending ORDER BY created_at,queue LIMIT 1`)
  ).rows[0];
  return !pending || pending.queue === queue;
}
