"use client";
import { useEffect, useRef, useState } from "react";
import { formatUsdc } from "../../domain/event-draft";
import { DotText } from "../dot-text";
import { JourneyStatus } from "./journey-status";
import { JourneyStrip, attendeeJourney } from "./journey-strip";
import { LiveCode } from "./live-code";

type Claim = { remaining: string; paid: string; pending: boolean; inFlight: string; total: string };
type Action = { id: string; kind: string; state: string; transactionUrl: string | null };
type View = {
  nft?: {
    winner: boolean;
    recipient: string | null;
    state: string;
    transactionUrl: string | null;
  } | null;
  status: string;
  hasNft?: boolean;
  code?: string | null;
  codeExpiresAt?: string | null;
  startsAt?: number;
  endsAt?: number;
  funded?: boolean;
  attended?: boolean;
  winner?: boolean;
  payout?: string;
  principal?: string;
  share?: string;
  prize?: string;
  claim: Claim;
  withdrawalQueued?: boolean;
  payoutTransactionUrl?: string | null;
  recovery?: Claim;
  roster?: { alias: string; funded: boolean; attended: boolean; winner: boolean }[];
  actions: Action[];
};
export function V1EventConsole({
  eventId,
  host = false,
  active = true,
}: {
  eventId: string;
  host?: boolean;
  active?: boolean;
}) {
  const [view, setView] = useState<View | null>(null),
    [message, setMessage] = useState(""),
    [actionError, setActionError] = useState(""),
    [readError, setReadError] = useState(""),
    [busy, setBusy] = useState(false),
    [code, setCode] = useState(""),
    [closeConsent, setCloseConsent] = useState(false);
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  const pending = useRef<{
    operationId: string;
    operation: string;
    code?: string;
    claim?: string;
  } | null>(null);
  const serial = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      const version = ++serial.current;
      try {
        const response = await fetch(
          `/api/events/mainnet?event=${eventId}&view=${host ? "host" : "receipt"}`,
          { cache: "no-store", signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Event status unavailable.");
        if (!controller.signal.aborted && version === serial.current) {
          setView(result);
          setReadError("");
        }
      } catch (error) {
        if (!controller.signal.aborted && version === serial.current)
          setReadError(error instanceof Error ? error.message : "Event status unavailable.");
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 10000);
    }
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [eventId, host]);
  async function act(operation: string, claim?: string) {
    setBusy(true);
    setMessage("");
    setActionError("");
    const current = {
      operation,
      ...(operation === "check_in" ? { code } : {}),
      ...(claim ? { claim } : {}),
    };
    if (
      !pending.current ||
      JSON.stringify({ ...pending.current, operationId: undefined }) !== JSON.stringify(current)
    )
      pending.current = { operationId: crypto.randomUUID(), ...current };
    try {
      const response = await fetch("/api/events/mainnet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, ...pending.current }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) pending.current = null;
        throw new Error(result.error ?? "Action unavailable.");
      }
      pending.current = null;
      if (operation === "code")
        setView((old) =>
          old ? { ...old, code: result.code, codeExpiresAt: result.expiresAt } : old,
        );
      if (operation === "check_in") setCode("");
      setMessage(
        operation === "code"
          ? "Share this code only with attendees who are here."
          : "Request saved. Confirmation appears after the contract records it.",
      );
      const version = ++serial.current;
      const latest = await fetch(
        `/api/events/mainnet?event=${eventId}&view=${host ? "host" : "receipt"}`,
        { cache: "no-store" },
      );
      if (latest.ok) {
        const result = await latest.json();
        if (version === serial.current) {
          setView(result);
          setReadError("");
        }
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Request status unknown. Retry the same request.",
      );
    } finally {
      setBusy(false);
    }
  }
  const terminal = view && ["settled", "cancelled"].includes(view.status),
    closing = view?.actions.some(
      (a) => ["settle", "cancel"].includes(a.kind) && a.state !== "failed",
    );
  const refund = !host && view?.status === "cancelled" && view.funded;
  const withdrawalPending = view?.claim.pending || view?.withdrawalQueued;
  const refundPaid =
    refund && view.claim.paid !== "0" && view.claim.remaining === "0" && !withdrawalPending;
  const payoutPaid =
    !host &&
    !refund &&
    terminal &&
    view.claim.paid !== "0" &&
    view.claim.remaining === "0" &&
    !withdrawalPending;
  const refundReady = refund && BigInt(view.claim.remaining) > 0n && !withdrawalPending;
  const checkInPending =
    !view?.attended &&
    view?.actions.some(
      (action) =>
        action.kind === "check_in" && ["requested", "prepared", "submitted"].includes(action.state),
    );
  const withdraw = (
    <button
      type="button"
      className="primary-button"
      disabled={busy}
      onClick={() => void act("withdraw", host ? "prize" : "deposit")}
    >
      {host ? "Return the prize to my wallet" : "Withdraw USDC to my NEAR wallet"}
    </button>
  );
  return (
    <section
      className={host ? "saved-panel host-event-controls" : "saved-panel"}
      aria-label={host ? "Host mainnet controls" : "Check-in and receipt"}
      style={{ overflowWrap: "anywhere" }}
    >
      <h2 id={host ? undefined : "refund"}>
        {host ? "Event controls" : refund ? "Your refund" : "Your check-in and receipt"}
      </h2>
      {actionError || readError ? (
        <JourneyStatus
          tone="blocked"
          title={actionError ? "Request needs attention" : "Status unavailable"}
        >
          {actionError || readError}
        </JourneyStatus>
      ) : busy || !view ? (
        <JourneyStatus
          tone="checking"
          title={
            busy
              ? "Checking your request"
              : host
                ? "Checking event status"
                : "Checking your receipt"
          }
        >
          {!busy &&
            host &&
            "Showup is verifying the event on NEAR. The controls will appear when the check finishes."}
        </JourneyStatus>
      ) : (
        message &&
        !refund &&
        !checkInPending &&
        !view.attended &&
        !closing && <p role="status">{message}</p>
      )}
      {!view ? (
        <p>Keep this page open to check again.</p>
      ) : (
        <>
          {host ? (
            <>
              {view.status === "cancelled" && (
                <JourneyStatus tone="confirmed" title="Event cancelled">
                  {view.hasNft
                    ? "To send the prize back, open the Ethereum NFT prize panel and select Return NFT to contributor."
                    : "Attendees can withdraw any refundable deposits from their receipts."}
                </JourneyStatus>
              )}
              {view.status === "published" && active && (
                <>
                  <p>
                    Open a code when the event starts. It expires after three minutes. Check-ins are
                    confirmed on NEAR.
                  </p>
                  <button
                    type="button"
                    disabled={
                      busy || closing || now < (view.startsAt ?? 0) || now >= (view.endsAt ?? 0)
                    }
                    onClick={() => void act("code")}
                  >
                    Show a fresh check-in code
                  </button>
                  {now < (view.startsAt ?? 0) && !closing && (
                    <p>Check-in codes become available when the event starts.</p>
                  )}
                  {view.code && view.codeExpiresAt && Date.parse(view.codeExpiresAt) > now && (
                    <LiveCode code={view.code} expiresAt={view.codeExpiresAt} now={now} />
                  )}
                  <JourneyStatus tone="action" title="Close or cancel the event">
                    Settlement is available after the scheduled end. Checked-in attendees get their
                    deposit back and share no-show deposits. Cancelling makes attendee deposits
                    refundable. Network fees still apply. To end early, cancel and return deposits.
                  </JourneyStatus>
                  <label className="consent-field">
                    <input
                      type="checkbox"
                      checked={closeConsent}
                      onChange={(e) => setCloseConsent(e.target.checked)}
                    />
                    I understand what happens to check-in and deposits.
                  </label>
                  {!closeConsent && !closing && <p>Tick the checkbox to enable cancellation.</p>}
                  <button
                    type="button"
                    disabled={busy || closing || !closeConsent || now < (view.endsAt ?? 0)}
                    onClick={() => void act("settle")}
                  >
                    Close and settle event
                  </button>
                  <button
                    type="button"
                    disabled={busy || closing || !closeConsent}
                    onClick={() => void act("cancel")}
                  >
                    Cancel and return deposits
                  </button>
                  {closing && (
                    <JourneyStatus tone="checking" title="Event closing">
                      Accepted check-ins finish before closing.
                    </JourneyStatus>
                  )}
                </>
              )}
              {view.status === "draft" && active && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      checked={closeConsent}
                      onChange={(event) => setCloseConsent(event.target.checked)}
                    />
                    Cancel this unpublished event so funded prizes can be returned.
                  </label>
                  <button
                    type="button"
                    disabled={busy || closing || !closeConsent}
                    onClick={() => void act("cancel")}
                  >
                    Cancel unpublished event
                  </button>
                </>
              )}
              <h3>Attendance</h3>
              <ul>
                {view.roster?.map((r) => (
                  <li key={r.alias}>
                    {r.alias + ": "}
                    {r.attended
                      ? "Checked in"
                      : r.funded
                        ? "Funded, awaiting check-in"
                        : "Deposit not confirmed"}
                    {r.winner ? " · Draw winner" : ""}
                  </li>
                ))}
              </ul>
              {view.roster?.length === 0 && (
                <div className="empty-state">
                  <p className="empty-state-title">No registrations yet.</p>
                  <p>Attendees appear here once they register through an invitation link.</p>
                </div>
              )}
            </>
          ) : (
            <>
              {(view.funded || payoutPaid || refundPaid) && (
                <JourneyStrip
                  steps={attendeeJourney({
                    registered: true,
                    funded: Boolean(view.funded),
                    attended: Boolean(view.attended),
                    paid: Boolean(payoutPaid || refundPaid),
                    ended: Boolean(terminal),
                    cancelled: view.status === "cancelled",
                  })}
                />
              )}
              {view.attended ? (
                <JourneyStatus tone="confirmed" title="Check-in confirmed">
                  NEAR has recorded your attendance.
                </JourneyStatus>
              ) : checkInPending ? (
                <JourneyStatus tone="checking" title="Check-in pending">
                  Showup is waiting for NEAR to record your attendance.
                </JourneyStatus>
              ) : (
                !terminal && (
                  <p>
                    {view.funded
                      ? "Deposit confirmed. You can check in during the live event."
                      : "Your deposit is not confirmed."}
                  </p>
                )
              )}
              {active &&
                view.funded &&
                !view.attended &&
                view.status === "published" &&
                !closing && (
                  <JourneyStatus
                    tone="action"
                    title="Check in with the host’s code"
                    actions={
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act("check_in");
                        }}
                      >
                        <label htmlFor="v1-live-code">Host&apos;s six-digit check-in code</label>
                        <input
                          id="v1-live-code"
                          value={code}
                          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                          inputMode="numeric"
                          autoComplete="off"
                          pattern="[0-9]{6}"
                          required
                        />
                        <button type="submit" disabled={busy || code.length !== 6}>
                          Check in
                        </button>
                      </form>
                    }
                  />
                )}
              {terminal && !refund && (
                <div className="ticket">
                  {view.winner && (
                    <p className="draw-banner draw-reveal" aria-hidden="true">
                      ★ Winner
                    </p>
                  )}
                  <h3 className={view.winner ? "draw-reveal" : undefined}>
                    {view.winner ? "You won the draw" : "Your result"}
                  </h3>
                  <p className="ticket-total">
                    <span className="dot-number">
                      <DotText
                        value={formatUsdc(
                          BigInt(view.principal ?? "0") +
                            BigInt(view.share ?? "0") +
                            BigInt(view.prize ?? "0"),
                        )}
                      />
                    </span>
                    <span>USDC total</span>
                  </p>
                  <div className="ticket-tear" aria-hidden="true" />
                  <dl>
                    <dt>Deposit eligible for return</dt>
                    <dd>{formatUsdc(BigInt(view.principal ?? "0")) + " USDC"}</dd>
                    <dt>No-show share</dt>
                    <dd>{formatUsdc(BigInt(view.share ?? "0")) + " USDC"}</dd>
                    <dt>Draw prize</dt>
                    <dd>{formatUsdc(BigInt(view.prize ?? "0")) + " USDC"}</dd>
                  </dl>
                  {view.funded && view.principal === "0" && (
                    <p>You did not check in. Your deposit was shared among checked-in attendees.</p>
                  )}
                  <p>{`NEAR payout wallet: ${view.payout}`}</p>
                </div>
              )}
            </>
          )}
          {view.nft?.winner && (
            <section aria-label="Your NFT prize">
              <h3>You won the NFT prize</h3>
              <p>{`Ethereum recipient: ${view.nft.recipient}. Delivery: ${view.nft.state}.`}</p>
              {view.nft.transactionUrl && (
                <a href={view.nft.transactionUrl} target="_blank" rel="noopener noreferrer">
                  View the NFT transaction on Ethereum
                </a>
              )}
            </section>
          )}
          {(host ? terminal : true) && (
            <>
              {refund && (
                <JourneyStatus
                  tone={refundPaid ? "confirmed" : refundReady ? "action" : "checking"}
                  title={
                    refundPaid
                      ? "Refund received"
                      : refundReady
                        ? "Refund available"
                        : "Refund pending"
                  }
                  actions={refundReady ? withdraw : undefined}
                >
                  {refundPaid
                    ? `${formatUsdc(BigInt(view.claim.paid))} USDC paid to your NEAR wallet.`
                    : refundReady
                      ? `${formatUsdc(BigInt(view.claim.remaining))} USDC is ready to send to your NEAR wallet.`
                      : withdrawalPending
                        ? "We’re checking the original withdrawal."
                        : "Waiting for your refund to appear."}
                </JourneyStatus>
              )}
              {payoutPaid && (
                <JourneyStatus tone="confirmed" title="Payout received">
                  {`${formatUsdc(BigInt(view.claim.paid))} USDC sent to your NEAR wallet. No action needed.`}
                </JourneyStatus>
              )}
              {(refundPaid || payoutPaid) && view.payoutTransactionUrl && (
                <div className="receipt-links">
                  <a href={view.payoutTransactionUrl} target="_blank" rel="noopener noreferrer">
                    View payout transaction
                  </a>
                  <code className="transaction-hash">
                    {view.payoutTransactionUrl.split("/").at(-1)}
                  </code>
                </div>
              )}
              <p>
                {`USDC paid: ${formatUsdc(BigInt(view.claim.paid))}. Ready to withdraw: ${formatUsdc(BigInt(view.claim.remaining))}.`}
              </p>
              {withdrawalPending && !refund && (
                <JourneyStatus tone="checking" title="Transfer pending">
                  Showup is checking the original transfer.
                </JourneyStatus>
              )}
              {!refund && BigInt(view.claim.remaining) > 0n && !withdrawalPending && withdraw}
            </>
          )}
          {view.recovery && BigInt(view.recovery.remaining) > 0n && !view.recovery.pending && (
            <button type="button" disabled={busy} onClick={() => void act("withdraw", "recovery")}>
              Recover unmatched deposit
            </button>
          )}
          <h3>Contract transactions</h3>
          <ul>
            {view.actions.map((a) => (
              <li key={a.id}>
                {a.kind.replaceAll("_", " ") + ": " + a.state}
                {a.transactionUrl && (
                  <>
                    {" · "}
                    <a href={a.transactionUrl} target="_blank" rel="noopener noreferrer">
                      View transaction
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
