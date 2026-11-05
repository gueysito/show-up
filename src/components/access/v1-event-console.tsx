"use client";
import { useEffect, useRef, useState } from "react";
import { formatUsdc } from "../../domain/event-draft";

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
        if (!controller.signal.aborted && version === serial.current) setView(result);
      } catch (error) {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : "Event status unavailable.");
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
        if (version === serial.current) setView(result);
      }
    } catch (error) {
      setMessage(
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
  return (
    <section
      className="saved-panel"
      aria-label={host ? "Host mainnet controls" : "Check-in and receipt"}
      style={{ overflowWrap: "anywhere" }}
    >
      <h2>{host ? "Event controls" : "Your check-in and receipt"}</h2>
      <p role="status" aria-live="polite">
        {message || (view ? `Contract status: ${view.status}.` : "Loading the contract receipt…")}
      </p>
      {!view ? (
        <p>Keep this page open to check again.</p>
      ) : (
        <>
          {host ? (
            <>
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
                  {view.code && view.codeExpiresAt && Date.parse(view.codeExpiresAt) > now && (
                    <p>
                      <strong
                        aria-label="Live check-in code"
                        style={{ fontSize: "2rem", letterSpacing: ".2em" }}
                      >
                        {view.code}
                      </strong>
                      <br />
                      {`Valid until ${new Date(view.codeExpiresAt).toLocaleTimeString()}.`}
                    </p>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={closeConsent}
                      onChange={(e) => setCloseConsent(e.target.checked)}
                    />
                    I understand closing ends check-in. Cancellation returns deposits and the funded
                    prize.
                  </label>
                  <button
                    type="button"
                    disabled={busy || closing || !closeConsent || now < (view.startsAt ?? 0)}
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
                    <p>The event is closing. Accepted check-ins finish before closing.</p>
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
              {view.roster?.length === 0 && <p>No registrations yet.</p>}
            </>
          ) : (
            <>
              <p>
                {view.attended
                  ? "Checked in · confirmed by the contract"
                  : view.funded
                    ? "Deposit confirmed. You can check in during the live event."
                    : "Your deposit is not confirmed."}
              </p>
              {active &&
                view.funded &&
                !view.attended &&
                view.status === "published" &&
                !closing && (
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
                )}
              {terminal && (
                <>
                  <h3 className={view.winner ? "draw-reveal" : undefined}>
                    {view.winner ? "You won the draw" : "Your result"}
                  </h3>
                  <dl>
                    <dt>Deposit returned</dt>
                    <dd>{formatUsdc(BigInt(view.principal ?? "0")) + " USDC"}</dd>
                    <dt>No-show share</dt>
                    <dd>{formatUsdc(BigInt(view.share ?? "0")) + " USDC"}</dd>
                    <dt>Draw prize</dt>
                    <dd>{formatUsdc(BigInt(view.prize ?? "0")) + " USDC"}</dd>
                  </dl>
                  {view.funded && view.principal === "0" && (
                    <p>You did not check in. Your deposit was shared among checked-in attendees.</p>
                  )}
                  <p>{`Payout Withdrawal Wallet: ${view.payout}`}</p>
                </>
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
              <p>
                {`USDC paid: ${formatUsdc(BigInt(view.claim.paid))}. Ready to withdraw: ${formatUsdc(BigInt(view.claim.remaining))}.`}
              </p>
              {view.claim.pending && (
                <p>The original token transfer is pending. Do not request another.</p>
              )}
              {BigInt(view.claim.remaining) > 0n && !view.claim.pending && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void act("withdraw", host ? "prize" : "deposit")}
                >
                  {host ? "Return the prize to my wallet" : "Withdraw USDC to my NEAR wallet"}
                </button>
              )}
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
