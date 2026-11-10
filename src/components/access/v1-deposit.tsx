"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import type { OwnWallet } from "../../server/wallets/service";
import { formatUsdc } from "../../domain/event-draft";
import { V1RouteReview, type V1RouteSummary } from "./v1-route-review";
import { NearWalletPaymentButton } from "./near-wallet-payment";
import type { NearWalletPayment } from "./near-mobile-wallet";
import { JourneyStatus, type JourneyTone } from "./journey-status";

type Status = {
  sourceNetwork?: string;
  sourceAddress?: string;
  route?: V1RouteSummary | null;
  state: string;
  funded: boolean;
  registrationId?: string;
  wallet?: string;
  payout?: string;
  walletId?: string;
  amountAtomic?: string;
  recovery?: string;
  transactionUrl?: string | null;
  depositTransactionUrl?: string | null;
};

function postDepositAction(eventId: string, operation: string, fields = {}, signal?: AbortSignal) {
  return fetch("/api/commitments/mainnet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId, operation, operationId: crypto.randomUUID(), ...fields }),
    signal,
  });
}

export function V1Deposit({
  eventId,
  rulesHash,
  amount,
  wallets,
  nft = false,
  walletConnectProjectId,
}: {
  eventId: string;
  rulesHash: string;
  amount: string;
  wallets: OwnWallet[];
  nft?: boolean;
  walletConnectProjectId?: string;
}) {
  const ethereum = wallets.filter((wallet) => wallet.network === "ethereum");
  const [ethereumWalletId, setEthereumWalletId] = useState(
    ethereum.length === 1 ? ethereum[0].id : "",
  );
  const near = wallets.filter((wallet) => wallet.network === "near");
  const [walletId, setWalletId] = useState(near.length === 1 ? near[0].id : "");
  const sources = wallets.filter((wallet) =>
    ["near", "base", "ethereum", "solana"].includes(wallet.network),
  );
  const [sourceWalletId, setSourceWalletId] = useState(near.length === 1 ? near[0].id : "");
  const selectedSource = sources.find((wallet) => wallet.id === sourceWalletId);
  const [routing, setRouting] = useState(false);
  const checkRouting = useCallback(() => setRouting(true), []);
  const [checkingEscrow, setCheckingEscrow] = useState(false);
  const [consent, setConsent] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [notice, setNotice] = useState<{ tone: JourneyTone; title: string; text: string } | null>(null),
    [busy, setBusy] = useState(false);
  const sourceNetwork = status?.sourceNetwork ?? selectedSource?.network ?? "near";
  const operation = useRef<{
    walletId: string;
    sourceWalletId: string;
    ethereumWalletId: string;
    operationId: string;
  } | null>(null);
  useEffect(() => {
    if (!routing && !checkingEscrow) return;
    const controller = new AbortController();
    async function poll() {
      try {
        const maxChecks = routing ? 12 : 6;
        for (let attempt = 0; attempt < maxChecks; attempt++) {
          const response = await fetch(`/api/commitments/mainnet?event=${eventId}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error ?? "Deposit status unavailable. Check again shortly.");
          if (controller.signal.aborted) return;
          setStatus(result);
          if (result.funded) {
            setNotice(null);
            return;
          }
          if (attempt + 1 < maxChecks) await new Promise((resolve) => setTimeout(resolve, 5000));
          if (controller.signal.aborted) return;
        }
        setNotice({
          tone: "action",
          title: "Deposit still pending",
          text: "Tap Check deposit status to check the original payment again.",
        });
      } catch (error) {
        if (!controller.signal.aborted)
          setNotice({
            tone: "blocked",
            title: "Deposit status unavailable",
            text: error instanceof Error ? error.message : "Check the original deposit status.",
          });
      } finally {
        if (!controller.signal.aborted) {
          setRouting(false);
          setCheckingEscrow(false);
        }
      }
    }
    void poll();
    return () => controller.abort();
  }, [routing, checkingEscrow, eventId]);
  useEffect(() => {
    // Transaction hashes and wallet errors are untrusted return parameters.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    const controller = new AbortController();
    fetch(`/api/commitments/mainnet?event=${eventId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const initial: Status = await response.json();
        if (!controller.signal.aborted) setStatus((current) => current ?? initial);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [eventId]);
  const missingReceipt =
    status?.funded && status.sourceNetwork === "near" && !status.depositTransactionUrl
      ? status.registrationId
      : undefined;
  useEffect(() => {
    if (!missingReceipt) return;
    const controller = new AbortController();
    postDepositAction(eventId, "confirm", {}, controller.signal)
      .then(async (response) => {
        if (!response.ok) return;
        const result: Status = await response.json();
        if (controller.signal.aborted || result.registrationId !== missingReceipt) return;
        setStatus((current) =>
          current?.registrationId === missingReceipt && result.depositTransactionUrl
            ? { ...current, depositTransactionUrl: result.depositTransactionUrl }
            : current,
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [eventId, missingReceipt]);
  async function prepareWalletPayment(
    kind: "pay" | "storage",
  ): Promise<NearWalletPayment | { ready: true }> {
    const response = await fetch("/api/commitments/mainnet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: kind,
        eventId,
        operationId: crypto.randomUUID(),
        ...(kind === "storage" ? { walletId: status?.walletId ?? walletId } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Check the original deposit status before retrying.");
    return result;
  }
  async function confirmStorage() {
    const result = await prepareWalletPayment("storage");
    if (!("ready" in result))
      throw new Error("USDC receiving is not confirmed yet. Check again shortly.");
    setNotice({
      tone: "confirmed",
      title: "Payout wallet ready",
      text: "Your NEAR payout wallet is ready to receive USDC.",
    });
  }
  async function action(kind: "register" | "confirm") {
    setBusy(true);
    setNotice(null);
    if (
      !operation.current ||
      operation.current.walletId !== walletId ||
      operation.current.sourceWalletId !== sourceWalletId ||
      operation.current.ethereumWalletId !== ethereumWalletId
    )
      operation.current = {
        walletId,
        sourceWalletId,
        ethereumWalletId,
        operationId: crypto.randomUUID(),
      };
    try {
      const response = await postDepositAction(eventId, kind, {
        ...(kind === "register"
          ? { operationId: operation.current.operationId, rulesHash, walletId, sourceWalletId }
          : {}),
        ...(kind === "register" && nft ? { ethereumWalletId } : {}),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Deposit not confirmed. Check the original status before retrying.",
        );
      setStatus((current) => (kind === "confirm" ? { ...current, ...result } : result));
      if (kind === "register" && result.state !== "registered")
        setNotice({
          tone: "checking",
          title: "Registration queued",
          text: "Check deposit status before approving a payment.",
        });
    } catch (error) {
      setNotice({
        tone: "blocked",
        title: "Deposit needs attention",
        text:
          error instanceof Error
            ? error.message
            : "Check the original deposit status before retrying.",
      });
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/commitments/mainnet?event=${eventId}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Status unavailable. Retry.");
      setStatus(result);
      if (result.funded && result.sourceNetwork === "near" && !result.depositTransactionUrl) {
        await action("confirm");
        return;
      }
      if (!result.funded && result.state !== "registered" && result.state !== "failed")
        setNotice({
          tone: "checking",
          title: "Waiting for registration",
          text: "Check deposit status before approving a payment.",
        });
    } catch (error) {
      setNotice({
        tone: "blocked",
        title: "Deposit status unavailable",
        text: error instanceof Error ? error.message : "Status unavailable. Retry.",
      });
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
      {status?.funded ? (
        <JourneyStatus
          tone="confirmed"
          title="Deposit confirmed"
          heading
          actions={
            status.depositTransactionUrl && (
              <a
                className="deposit-explorer-link"
                href={status.depositTransactionUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View deposit transaction on NEAR Explorer
              </a>
            )
          }
        >
          {`${amount} USDC received by escrow. Your seat is funded.`}
        </JourneyStatus>
      ) : (
        <h2>Deposit USDC on NEAR</h2>
      )}
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
          {nft && (
            <div>
              <label htmlFor="v1-nft-recipient">Ethereum wallet for the NFT prize</label>
              <select
                id="v1-nft-recipient"
                value={ethereumWalletId}
                onChange={(event) => setEthereumWalletId(event.target.value)}
                disabled={busy}
              >
                <option value="">Choose your verified Ethereum wallet</option>
                {ethereum.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.address}
                  </option>
                ))}
              </select>
              <p>If you win, the NFT goes to this address. It locks with your registration.</p>
              <p>
                <Link href="/account/wallets" prefetch={false}>
                  Verify a wallet
                </Link>
              </p>
            </div>
          )}
          <label htmlFor="v1-source-wallet">Deposit Wallet</label>
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
            <option value="">Choose the wallet you’ll pay from</option>
            {sources.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {`${wallet.network.toUpperCase()} · ${wallet.address}`}
              </option>
            ))}
          </select>
          <label htmlFor="v1-deposit-wallet">Payout Withdrawal Wallet</label>
          <select
            id="v1-deposit-wallet"
            aria-describedby="v1-payout-wallet-note"
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
          <p id="v1-payout-wallet-note">This NEAR wallet receives your USDC refunds and payouts.</p>
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
        <p>{`Deposit Wallet: ${status.sourceAddress ?? status.wallet}. Payout Withdrawal Wallet: ${status.payout ?? status.wallet}`}</p>
      )}
      {status?.state === "registered" && !status.funded && sourceNetwork !== "near" && (
        <V1RouteReview
          registrationId={status.registrationId!}
          eventId={eventId}
          network={sourceNetwork}
          address={status.sourceAddress!}
          initial={status.route}
          onSubmitted={checkRouting}
          walletConnectProjectId={walletConnectProjectId}
        />
      )}
      {sourceNetwork !== "near" && !status?.funded && (
        <>
          <p>
            Your NEAR payout wallet needs USDC token registration once. Wallet setup attaches at
            most 0.00125 NEAR; keep a separate 0.16-NEAR gas reserve.
          </p>
          <NearWalletPaymentButton
            key={`storage:${status?.walletId ?? walletId}`}
            scope={`storage:${status?.walletId ?? walletId}`}
            disabled={busy || !(status?.walletId ?? walletId)}
            prepare={() => prepareWalletPayment("storage")}
            confirm={confirmStorage}
          />
        </>
      )}
      {status?.state === "registered" && !status.funded && sourceNetwork === "near" && (
        <>
          <p>
            Your registration is ready. Approve the exact USDC payment in your wallet. This
            registration does not reserve a funded seat.
          </p>
          <NearWalletPaymentButton
            key={`deposit:${status.registrationId}`}
            scope={`deposit:${status.registrationId}`}
            disabled={busy || checkingEscrow}
            prepare={() => prepareWalletPayment("pay")}
            confirm={() => {
              setNotice(null);
              setCheckingEscrow(true);
              return Promise.resolve();
            }}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy || checkingEscrow}
            onClick={() => action("confirm")}
          >
            Confirm my deposit
          </button>
        </>
      )}
      {!status?.funded && status?.depositTransactionUrl && (
        <p>
          <a
            className="deposit-explorer-link"
            href={status.depositTransactionUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View deposit transaction on NEAR Explorer
          </a>
        </p>
      )}
      {missingReceipt && (
        <p>
          The transaction link will appear once verified. Tap Check deposit status to check again.
        </p>
      )}
      {status?.recovery && BigInt(status.recovery) > 0n && (
        <p>{`${formatUsdc(BigInt(status.recovery))} USDC is held for recovery to your refund wallet; it does not create another seat.`}</p>
      )}
      {status?.state === "failed" && (
        <JourneyStatus tone="blocked" title="Registration failed">
          Registration failed. Its original transaction is retained for review. Do not send USDC.
        </JourneyStatus>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy || checkingEscrow}
        onClick={check}
      >
        Check deposit status
      </button>
      {status?.transactionUrl && (
        <p>
          <a href={status.transactionUrl} target="_blank" rel="noopener noreferrer">
            View registration transaction
          </a>
        </p>
      )}
      {!status?.funded &&
        status?.state !== "failed" &&
        (notice ? (
          <JourneyStatus tone={notice.tone} title={notice.title}>
            {notice.text}
          </JourneyStatus>
        ) : checkingEscrow ? (
          <JourneyStatus tone="checking" title="Waiting for escrow">
            NEAR is checking whether escrow received your deposit.
          </JourneyStatus>
        ) : busy ? (
          <JourneyStatus tone="checking" title="Checking deposit status" />
        ) : null)}
    </section>
  );
}
