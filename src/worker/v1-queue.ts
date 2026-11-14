import type pg from "pg";
// Native queues share admission even when an isolated route account owns its
// nonce. Reconcile an unknown original image before preparing another queue.
export async function v1QueueAdmitted(
  pool: pg.Pool,
  queue: "publication" | "registration" | "action" | "route_account" | "route_withdrawal",
) {
  const pending = (
    await pool.query(`SELECT queue FROM (
    SELECT 'publication' AS queue,created_at FROM app_publication_images WHERE environment='near-mainnet-v1' AND transaction_state IN ('prepared','submitted')
    UNION ALL SELECT 'registration',created_at FROM app_v1_registrations WHERE state IN ('prepared','submitted')
    UNION ALL SELECT 'action',created_at FROM app_v1_event_actions WHERE state IN ('prepared','submitted')
    UNION ALL SELECT 'route_account',created_at FROM app_v1_route_accounts WHERE state IN ('prepared','submitted')
    UNION ALL SELECT 'route_withdrawal',created_at FROM app_v1_route_withdrawals WHERE state IN ('prepared','submitted')
  ) pending ORDER BY created_at,queue LIMIT 1`)
  ).rows[0];
  return !pending || pending.queue === queue;
}
