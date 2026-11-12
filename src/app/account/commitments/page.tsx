import { formatUsdc } from "../../../domain/event-draft";
import { readV1PaidRefund } from "../../../server/events/v1-actions";
import { AppHeader } from "../../../components/app-header";
import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { sessionCookie } from "../../../server/auth/sessions";
import { findPrivacySession } from "../../../server/privacy/access";
import { createDatabase } from "../../../server/db/client";
import {
  listOwnFinancialRecords,
  type OwnFinancialRecord,
} from "../../../server/commitments/records";
import { AttendanceCodeEntry } from "../../../components/access/attendance-code-entry";
import { AttendancePersonalQr } from "../../../components/access/attendance-personal-qr";
import { TelegramCheckIn } from "../../../components/access/telegram-check-in";
import { EventTime } from "../../../components/access/event-time";
import {
  FinancialTermsSummary,
  consentMoneyAmount,
} from "../../../components/access/financial-terms-summary";

export const dynamic = "force-dynamic";
function amount(value: string, record: OwnFinancialRecord) {
  return consentMoneyAmount(value, record.terms);
}
export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string; event?: string }>;
}) {
  const query = await searchParams,
    config = authConfig();
  type EventReceipt = {
    eventId: string;
    title: string;
    startsAt: string;
    timeZone: string;
    amount: string;
    eventState: string;
    cancelled: boolean;
    pending: boolean;
    paid: boolean;
    paidRefund?: Awaited<ReturnType<typeof readV1PaidRefund>>;
  };
  let signedIn = false,
    activeAccount = false,
    available = Boolean(config),
    records: OwnFinancialRecord[] = [],
    receipts: EventReceipt[] = [],
    nextCursor: string | null = null;
  if (config) {
    const { pool } = createDatabase();
    try {
      const session = await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value);
      signedIn = Boolean(session);
      activeAccount = session?.state === "active";
      if (session) {
        ({ records, nextCursor } = await listOwnFinancialRecords(
          pool,
          config,
          session.tokenHash,
          query.before,
          query.event,
        ));
        ({ rows: receipts } = await pool.query<EventReceipt>(
          `SELECT e.id AS "eventId",e.data->>'title' AS title,
              e.data->>'startsAt' AS "startsAt", e.data->>'timeZone' AS "timeZone",
              e.data->>'commitment' AS amount, e.state AS "eventState",
              EXISTS(SELECT 1 FROM app_v1_event_actions w WHERE w.event_id=e.id
                AND w.account_id=r.account_id AND w.target=r.id::text AND w.kind='withdraw'
                AND w.state IN ('requested','prepared','submitted')) AS pending,
              EXISTS(SELECT 1 FROM app_v1_event_actions w WHERE w.event_id=e.id
                AND w.account_id=r.account_id AND w.target=r.id::text AND w.kind='withdraw'
                AND w.state='verified' AND w.source_height IS NOT NULL
                AND w.transaction_hash IS NOT NULL) AS paid,
              EXISTS(SELECT 1 FROM app_v1_event_actions a WHERE a.event_id=e.id
                AND a.kind='cancel' AND a.state='verified') AS cancelled
             FROM app_v1_registrations r JOIN app_events e ON e.id=r.event_id
             JOIN app_sessions s ON s.account_id=r.account_id
             JOIN app_accounts a ON a.id=s.account_id
             WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
             AND a.state IN ('active','deletion_requested')
             AND r.state='funded' AND ($2::uuid IS NULL OR e.id=$2)
             ORDER BY r.created_at DESC,r.id DESC LIMIT 50`,
          [session.tokenHash, query.event ?? null],
        ));
        await Promise.all(
          receipts
            .filter((receipt) => receipt.cancelled && receipt.paid && !receipt.pending)
            .map(async (receipt) => {
              receipt.paidRefund = await readV1PaidRefund(
                pool,
                config,
                session.tokenHash,
                receipt.eventId,
              );
            }),
        );
      }
    } catch {
      available = false;
    } finally {
      await pool.end();
    }
  }
  return (
    <>
      <AppHeader area={"attend"} />
      <main>
        <Link href="/account" prefetch={false}>
          Back to your account
        </Link>
        <h1>Deposits and refunds</h1>
        {available && signedIn && (
          <section id="event-receipts" className="saved-panel" aria-label="Deposits and refunds">
            <h2>Your funded events</h2>
            {receipts.length ? (
              <ul>
                {receipts.map(
                  ({
                    eventId,
                    title,
                    startsAt,
                    timeZone,
                    amount,
                    cancelled,
                    eventState,
                    paid,
                    pending,
                    paidRefund,
                  }) => {
                    const status = cancelled
                      ? pending
                        ? "Refund pending"
                        : paidRefund
                          ? "Refund received"
                          : paid
                            ? "Review refund status"
                            : "Refund available"
                      : pending
                        ? "Payout pending"
                        : paid
                          ? "Payout received"
                          : eventState === "closed"
                            ? "Results available"
                            : "Deposit held";
                    const action = cancelled
                      ? pending || (paid && !paidRefund)
                        ? "Check refund status"
                        : paidRefund
                          ? "View receipt"
                          : "Withdraw refund"
                      : eventState === "closed"
                        ? "View results and payout"
                        : "View deposit and check-in";
                    return (
                      <li key={eventId} className="saved-panel event-summary">
                        <h3>{title}</h3>
                        <EventTime instant={startsAt} timeZone={timeZone} />
                        <p>
                          {paidRefund
                            ? `${formatUsdc(paidRefund.amount)} USDC refunded`
                            : `${amount} USDC deposit`}
                        </p>
                        <p>
                          <strong>{status}</strong>
                        </p>
                        <div className="receipt-links">
                          <Link
                            className={
                              cancelled && !pending && !paid ? "primary-button" : undefined
                            }
                            href={`/events/${eventId}/commit${cancelled ? "#refund" : ""}`}
                            prefetch={false}
                          >
                            {action}
                            <span className="visually-hidden">{` for ${title}`}</span>
                          </Link>
                          {paidRefund && (
                            <a
                              href={paidRefund.transactionUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View transaction
                            </a>
                          )}
                        </div>
                      </li>
                    );
                  },
                )}
              </ul>
            ) : (
              <p>
                No deposits yet. If you deposited with a different Showup sign-in, switch to that
                account to see its receipts.
              </p>
            )}
          </section>
        )}
        {query.event && (
          <p>
            <Link href="/account/commitments" prefetch={false}>
              Show all your event authorizations
            </Link>
          </p>
        )}
        {!available ? (
          <p role="alert">Financial records are temporarily unavailable. Reload to try again.</p>
        ) : !signedIn ? (
          <p>
            <Link href="/account" prefetch={false}>
              Sign in to view your financial authorizations
            </Link>
          </p>
        ) : (
          <details id="reviewed-terms" aria-label="Your financial records" open={!receipts.length}>
            <summary>Reviewed event terms</summary>
            <p>These authorizations record the terms you reviewed or approved for an event.</p>
            {!records.length && <p>No financial authorizations are saved on this account.</p>}
            {records.map((record) => (
              <article key={record.id} className="saved-panel">
                <h2>{record.eventTitle}</h2>
                <p>
                  {record.authorizedAt
                    ? "Financial terms approved"
                    : "Prepared terms · approval not recorded"}
                </p>
                <p>Escrow not confirmed. No funded seat is shown for this authorization.</p>
                {record.principalRecovery && (
                  <section aria-label="Principal recovery status">
                    <h3>Original principal recovery</h3>
                    <p>
                      {record.principalRecovery.status === "observed"
                        ? "A sandbox return observation is recorded. Real payment remains unconfirmed."
                        : record.principalRecovery.status === "conflict"
                          ? "Conflicting source records paused recovery. The original obligation remains owed."
                          : record.principalRecovery.status === "broadcast_unknown"
                            ? "Submission acknowledgement is unknown. Recovery checks the original request before another transfer."
                            : record.principalRecovery.status === "pending_transfer"
                              ? "The original transfer is pending. No second payment is confirmed."
                              : record.principalRecovery.status === "unavailable"
                                ? "Source records are unavailable. The original request and obligation remain retained."
                                : record.principalRecovery.status === "awaiting_liability"
                                  ? "Waiting for the contract's original return obligation. No return is confirmed."
                                  : "The original recovery request is queued or processing. No return is confirmed."}
                    </p>
                    {record.principalRecovery.lastEffect === "fail_neutral" && (
                      <p>
                        Recovery is reconciling the contract&apos;s fail-neutral abort before
                        principal withdrawal. It does not classify an outage as a no-show.
                      </p>
                    )}
                    <p>{`Last recovery update: ${record.principalRecovery.updatedAt}.`}</p>
                    <details>
                      <summary>Original recovery reference</summary>
                      <p style={{ overflowWrap: "anywhere" }}>
                        {record.principalRecovery.requestReference}
                      </p>
                    </details>
                  </section>
                )}
                {activeAccount &&
                  record.authorizedAt &&
                  record.eventState === "published" &&
                  !record.attendance &&
                  record.attendanceWindow?.mode === "digital" && (
                    <>
                      <AttendanceCodeEntry
                        key={record.id}
                        eventId={record.eventId}
                        consentId={record.id}
                        window={record.attendanceWindow}
                        timeZone={record.terms.timeZone}
                      />
                      <TelegramCheckIn eventId={record.eventId} consentId={record.id} />
                    </>
                  )}
                {activeAccount &&
                  record.authorizedAt &&
                  record.eventState === "published" &&
                  !record.attendance &&
                  record.attendanceWindow?.mode === "physical" && (
                    <AttendancePersonalQr
                      eventId={record.eventId}
                      consentId={record.id}
                      window={record.attendanceWindow}
                      timeZone={record.terms.timeZone}
                    />
                  )}
                {record.attendance && (
                  <section aria-label="Attendance evidence status">
                    <h3>Attendance not confirmed</h3>
                    <p>
                      {record.attendance.environment === "sandbox"
                        ? "Disposable sandbox evidence candidate only. No live attendance is confirmed."
                        : "A receipt candidate is recorded. Contract evidence is still pending."}
                    </p>
                    <p>{`Server arrival: ${record.attendance.receivedAt}. Classification: ${record.attendance.classification === "on_time" ? "on time" : "late"}.`}</p>
                    <p>Preparing this candidate does not sign, submit or confirm attendance.</p>
                  </section>
                )}
                {record.reconciliation.status !== "not_linked" && (
                  <section aria-label="Reconciliation status">
                    <h3>Financial record checks</h3>
                    {(record.reconciliation.eventState === "cancelled" ||
                      record.reconciliation.eventState === "aborted" ||
                      record.reconciliation.registrationState === "released") && (
                      <p>
                        {`${
                          record.reconciliation.registrationState === "released"
                            ? "Source records show a released commitment."
                            : record.reconciliation.eventState === "cancelled"
                              ? "Source records show host cancellation."
                              : "Source records show event abort."
                        } Return obligations remain tied to the original approved destinations; this unqualified observation does not confirm payment.`}
                      </p>
                    )}
                    <p>
                      {record.reconciliation.status === "paused"
                        ? "Conflicting source records paused this check. Existing obligations remain recorded."
                        : record.reconciliation.status === "source_unavailable"
                          ? "Source records are temporarily unavailable. Existing obligations remain recorded."
                          : record.reconciliation.status === "awaiting_observation"
                            ? "Waiting for finalized source records for this authorization."
                            : "Source records were compared, but this route is not qualified for escrow confirmation."}
                    </p>
                    {record.reconciliation.principalRemaining !== null && (
                      <p>{`Observed principal still owed: ${amount(record.reconciliation.principalRemaining, record)}. This is an unqualified observation, not a payment receipt.`}</p>
                    )}
                    {record.reconciliation.returnedRemaining !== null && (
                      <p>{`Observed source return still owed: ${amount(record.reconciliation.returnedRemaining, record)}. This is an unqualified observation, not a payment receipt.`}</p>
                    )}
                    <p>{`Last successful source check: ${record.reconciliation.lastSuccessAt ?? "Not recorded"}.`}</p>
                  </section>
                )}
                {record.authorizedAt && (
                  <section aria-label="Release and recovery availability">
                    <h3>Release and return</h3>
                    {record.releaseRequest && (
                      <p>{`Original release request saved. Release is not confirmed. Request reference: ${record.releaseRequest.operationId}; signing expiry: ${record.releaseRequest.expiresAt}. Reconcile that original action before preparing another request.`}</p>
                    )}
                    <p>Timely release must be accepted before:</p>
                    <EventTime
                      instant={record.terms.registrationClosesAt - 600_000}
                      timeZone={record.terms.timeZone}
                    />
                    <p>A deletion request does not release a commitment.</p>
                    <button type="button" className="secondary-button" disabled>
                      Release commitment · qualified route required
                    </button>
                    <p>
                      Release and return submission remain unavailable until the original route is
                      qualified. Unresolved records and recovery access remain retained even after
                      logout or a deletion request.
                    </p>
                    <Link href="/account/privacy" prefetch={false}>
                      Review retained data and deletion status
                    </Link>
                  </section>
                )}
                {record.terms.environment === "sandbox" && (
                  <p>Disposable sandbox tokens only. This record is not real USDC funding.</p>
                )}
                <FinancialTermsSummary terms={record.terms} />
                <p>
                  {record.authorizedAt
                    ? "These are the limits you approved. Actual fees and delivery have not been reconciled."
                    : "These proposed limits have not been approved. Actual fees and delivery have not been reconciled."}
                </p>
                <details>
                  <summary>Authorization details</summary>
                  <dl style={{ overflowWrap: "anywhere" }}>
                    <dt>Authorization reference</dt>
                    <dd>{record.id}</dd>
                    <dt>Event state</dt>
                    <dd>{record.eventState}</dd>
                    <dt>Rules commitment</dt>
                    <dd>{record.terms.rulesHash}</dd>
                    <dt>Prepared at</dt>
                    <dd>{record.createdAt}</dd>
                    <dt>Approved at</dt>
                    <dd>{record.authorizedAt ?? "Approval not recorded"}</dd>
                    <dt>Recorded quote reference</dt>
                    <dd>{record.terms.quoteHash}</dd>
                  </dl>
                </details>
              </article>
            ))}
            {nextCursor && (
              <p>
                <Link
                  href={`/account/commitments?before=${nextCursor}${query.event ? `&event=${encodeURIComponent(query.event)}` : ""}`}
                  prefetch={false}
                >
                  Older authorizations
                </Link>
              </p>
            )}
          </details>
        )}
      </main>
    </>
  );
}
