"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import type { OwnWallet } from "../../server/wallets/service";
import { formatUsdc } from "../../domain/event-draft";
import { V1RouteReview, type V1RouteSummary } from "./v1-route-review";

type Status = {
  sourceNetwork?: string;
  sourceAddress?: string;
  route?: V1RouteSummary | null;
  state: string;
  funded: boolean;
  registrationId?: string;
  wallet?: string;
  payout?: string;
  amountAtomic?: string;
  recovery?: string;
  transactionUrl?: string | null;
};
export function V1Deposit({
  eventId,
  rulesHash,
  amount,
  wallets,
}: {
  eventId: string;
  rulesHash: string;
  amount: string;
  wallets: OwnWallet[];
}) {
  const near = wallets.filter((wallet) => wallet.network === "near");
  const [walletId, setWalletId] = useState(near.length === 1 ? near[0].id : "");
  const sources = wallets.filter((wallet) => ["near", "base", "ethereum"].includes(wallet.network));
  const [sourceWalletId, setSourceWalletId] = useState(near.length === 1 ? near[0].id : "");
  const selectedSource = sources.find((wallet) => wallet.id === sourceWalletId);
  const [routing, setRouting] = useState(false);
  const [consent, setConsent] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const sourceNetwork = status?.sourceNetwork ?? selectedSource?.network ?? "near";
  const operation = useRef<{
    walletId: string;
    sourceWalletId: string;
    operationId: string;
  } | null>(null);
  useEffect(() => {
    if (!routing) return;
    const controller = new AbortController();
    async function poll() {
      try {
        for (let attempt = 0; attempt < 12; attempt++) {
          const response = await fetch(`/api/commitments/mainnet?event=${eventId}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error ?? "Routing status unavailable. Check again shortly.");
          if (controller.signal.aborted) return;
          setStatus(result);
          if (result.funded) {
            setMessage("Escrow confirms your deposit. Your seat is funded.");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
          if (controller.signal.aborted) return;
        }
        setMessage("The original route is still pending. Check deposit status; do not pay twice.");
      } catch (error) {
        if (!controller.signal.aborted)
          setMessage(error instanceof Error ? error.message : "Check the original routing status.");
      } finally {
        if (!controller.signal.aborted) setRouting(false);
      }
    }
    void poll();
    return () => controller.abort();
  }, [routing, eventId]);
  useEffect(() => {
    // Transaction hashes and wallet errors are untrusted return parameters.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    const controller = new AbortController();
    fetch(`/api/commitments/mainnet?event=${eventId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.ok) setStatus(await response.json());
      })
      .catch(() => {});
    return () => controller.abort();
  }, [eventId]);
  async function action(kind: "register" | "pay" | "confirm") {
    setBusy(true);
    setMessage("");
    if (
      !operation.current ||
      operation.current.walletId !== walletId ||
      operation.current.sourceWalletId !== sourceWalletId
    )
      operation.current = { walletId, sourceWalletId, operationId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/commitments/mainnet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: kind,
          eventId,
          operationId: kind === "register" ? operation.current.operationId : crypto.randomUUID(),
          ...(kind === "register" ? { rulesHash, walletId, sourceWalletId } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Deposit not confirmed. Check the original status before retrying.",
        );
      if (kind === "pay") {
        const url = new URL(result.walletUrl);
        if (
          url.origin !== "https://app.mynearwallet.com" ||
          url.pathname !== "/sign" ||
          url.searchParams.get("callbackUrl") !==
            `${window.location.origin}/events/${eventId}/commit`
        )
          throw new Error("Open Showup at its configured address before paying.");
        window.location.assign(url.href);
      } else {
        setStatus(result);
        setMessage(
          kind === "register"
            ? "Registration queued. Check status before approving the deposit."
            : "Escrow confirms your deposit. Your seat is funded.",
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Check the original deposit status before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    try {
      const response = await fetch(`/api/commitments/mainnet?event=${eventId}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Status unavailable. Retry.");
      setStatus(result);
      setMessage(
        result.funded
          ? "Escrow confirms your deposit. Your seat is funded."
          : "Status refreshed. A seat is confirmed only after the contract receives your deposit.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Status unavailable. Retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="saved-panel"
      aria-label="NEAR USDC deposit"
      style={{ overflowWrap: "anywhere" }}
    >
      <h2>{status?.funded ? "Deposit confirmed" : "Deposit USDC on NEAR"}</h2>
      <p>
        {sourceNetwork === "near"
          ? `${amount} USDC commitment. Pay from your verified NEAR wallet; refunds go to that same wallet.`
          : `${amount} USDC commitment in NEAR escrow. Pay from ${sourceNetwork.toUpperCase()}; event payouts go to your NEAR wallet.`}
      </p>
      <dl>
        <dt>Routing fee</dt>
        <dd>
          {sourceNetwork === "near"
            ? "0 USDC, direct NEAR transfer"
            : "Included in the signed quote shown before approval"}
        </dd>
        <dt>
          {sourceNetwork === "near" ? "Separate NEAR gas reserve" : "Separate source-chain gas"}
        </dt>
        <dd>
          {sourceNetwork === "near"
            ? "Up to 0.16 NEAR; unused gas is returned"
            : "Source-chain gas is separate and shown in the quote review"}
        </dd>
        <dt>Refund rule</dt>
        <dd>
          Attend to receive your deposit back. No-show deposits are shared among checked-in
          attendees.
        </dd>
      </dl>
      {(!status || status.state === "none") && (
        <>
          <label htmlFor="v1-source-wallet">Pay from wallet</label>
          <select
            id="v1-source-wallet"
            style={{ width: "100%", minWidth: 0 }}
            value={sourceWalletId}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              setSourceWalletId(id);
              setConsent(false);
              if (wallets.find((wallet) => wallet.id === id)?.network === "near") setWalletId(id);
            }}
          >
            <option value="">Choose a verified source wallet</option>
            {sources.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {`${wallet.network.toUpperCase()} · ${wallet.address}`}
              </option>
            ))}
          </select>
          <label htmlFor="v1-deposit-wallet">NEAR deposit and payout wallet</label>
          <select
            id="v1-deposit-wallet"
            style={{ width: "100%", minWidth: 0, maxWidth: "100%" }}
            value={walletId}
            disabled={busy}
            onChange={(event) => {
              setWalletId(event.target.value);
              if (sourceNetwork === "near") setSourceWalletId(event.target.value);
              setConsent(false);
            }}
          >
            <option value="">Choose a verified NEAR wallet</option>
            {near.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.address}
              </option>
            ))}
          </select>
          <p>
            <Link href={`/account/wallets?event=${eventId}`} prefetch={false}>
              Verify a NEAR wallet
            </Link>
          </p>
          <label>
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I reviewed the deposit, gas reserve, refund wallet and no-show rule.
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !walletId || !sourceWalletId || !consent}
            onClick={() => action("register")}
          >
            Prepare my deposit
          </button>
        </>
      )}
      {status?.wallet && (
        <p>{`Pay from: ${status.sourceAddress ?? status.wallet}. NEAR payout wallet: ${status.payout ?? status.wallet}`}</p>
      )}
      {status?.state === "registered" && !status.funded && sourceNetwork !== "near" && (
        <V1RouteReview
          eventId={eventId}
          network={sourceNetwork}
          address={status.sourceAddress!}
          initial={status.route}
          onSubmitted={() => setRouting(true)}
        />
      )}
      {status?.state === "registered" && !status.funded && sourceNetwork === "near" && (
        <>
          <p>
            Your registration is ready. Approve the exact USDC payment in your wallet. This
            registration does not reserve a funded seat.
          </p>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => action("pay")}
          >
            Approve USDC deposit in MyNearWallet
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => action("confirm")}
          >
            Confirm my deposit
          </button>
        </>
      )}
      {status?.funded && <p role="status">Your seat is funded. Do not send another deposit.</p>}
      {status?.recovery && BigInt(status.recovery) > 0n && (
        <p>{`${formatUsdc(BigInt(status.recovery))} USDC is held for recovery to your refund wallet; it does not create another seat.`}</p>
      )}
      {status?.state === "failed" && (
        <p role="alert">
          Registration failed. Its original transaction is retained for review. Do not send USDC.
        </p>
      )}
      <button type="button" className="secondary-button" disabled={busy} onClick={check}>
        Check deposit status
      </button>
      {status?.transactionUrl && (
        <p>
          <a href={status.transactionUrl} target="_blank" rel="noopener noreferrer">
            View registration transaction
          </a>
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
