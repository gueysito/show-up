import Link from "next/link";
import { cookies } from "next/headers";
import { formatUsdc } from "../../../domain/event-draft";
import { authConfig } from "../../../server/auth/config";
import { findSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import {
  listOwnFinancialRecords,
  type OwnFinancialRecord,
} from "../../../server/commitments/records";

export const dynamic = "force-dynamic";
function amount(value: string, record: OwnFinancialRecord) {
  return `${formatUsdc(BigInt(value))} ${record.terms.environment === "sandbox" ? "sandbox token units" : "USDC"}`;
}
export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}) {
  const query = await searchParams,
    config = authConfig();
  let signedIn = false,
    available = Boolean(config),
    records: OwnFinancialRecord[] = [],
    nextCursor: string | null = null;
  if (config) {
    const { pool } = createDatabase();
    try {
      const session = await findSession(pool, (await cookies()).get(sessionCookie)?.value);
      signedIn = Boolean(session);
      if (session)
        ({ records, nextCursor } = await listOwnFinancialRecords(
          pool,
          config,
          session.tokenHash,
          query.before,
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
              {record.reconciliation.status !== "not_linked" && (
                <section aria-label="Reconciliation status">
                  <h3>Financial record checks</h3>
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
              {record.terms.environment === "sandbox" && (
                <p>Disposable sandbox tokens only. This record is not real USDC funding.</p>
              )}
              <dl style={{ overflowWrap: "anywhere" }}>
                <dt>Principal</dt>
                <dd>{amount(record.terms.principal, record)}</dd>
                <dt>Maximum delivery fee</dt>
                <dd>{amount(record.terms.withdrawalFeeMaximum, record)}</dd>
                <dt>Minimum net payout</dt>
                <dd>{amount(record.terms.payoutMinimum, record)}</dd>
                <dt>Funding wallet</dt>
                <dd>{`${record.terms.source.network}: ${record.terms.source.address}`}</dd>
                <dt>Source refund destination</dt>
                <dd>{`${record.terms.refund.network}: ${record.terms.refund.address}`}</dd>
                <dt>Payout destination</dt>
                <dd>{`${record.terms.payout.network}: ${record.terms.payout.address}`}</dd>
              </dl>
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
                  <dt>Funding authorization expires</dt>
                  <dd>{new Date(record.terms.authorizationExpiresAt).toISOString()}</dd>
                </dl>
              </details>
            </article>
          ))}
          {nextCursor && (
            <p>
              <Link href={`/account/commitments?before=${nextCursor}`} prefetch={false}>
                Older authorizations
              </Link>
            </p>
          )}
        </section>
      )}
    </main>
  );
}
