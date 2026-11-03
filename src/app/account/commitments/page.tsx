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
  let signedIn = false,
    activeAccount = false,
    available = Boolean(config),
    records: OwnFinancialRecord[] = [],
    nextCursor: string | null = null;
  if (config) {
    const { pool } = createDatabase();
    try {
      const session = await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value);
      signedIn = Boolean(session);
      activeAccount = session?.state === "active";
      if (session)
        ({ records, nextCursor } = await listOwnFinancialRecords(
          pool,
          config,
          session.tokenHash,
          query.before,
          query.event,
        ));
    } catch {
      available = false;
    } finally {
      await pool.end();
    }
  }
  return (
    <main>
      <Link href="/account" prefetch={false}>
        Back to your account
      </Link>
      <h1>Your financial authorizations</h1>
      {query.event && (
        <p>
          <Link href="/account/commitments" prefetch={false}>
            Show all your event authorizations
          </Link>
        </p>
      )}
      <p>
        These records show the event terms you reviewed or approved. A signature does not confirm a
        deposit or book a seat.
      </p>
      {!available ? (
        <p role="alert">Financial records are temporarily unavailable. Reload to try again.</p>
      ) : !signedIn ? (
        <p>
          <Link href="/account" prefetch={false}>
            Sign in to view your financial authorizations
          </Link>
        </p>
      ) : (
        <section aria-label="Your financial records">
          {!records.length && <p>No financial authorizations are saved on this account.</p>}
          <p>
            Funding remains unavailable while attributable escrow and authorized returns are being
            verified.
          </p>
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
                  <AttendancePersonalQr eventId={record.eventId} consentId={record.id} />
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
                  <p>{`Timely release must be accepted before ${new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone: record.terms.timeZone }).format(new Date(record.terms.registrationClosesAt - 600_000))} (${record.terms.timeZone}). A deletion request does not release a commitment.`}</p>
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
        </section>
      )}
    </main>
  );
}
