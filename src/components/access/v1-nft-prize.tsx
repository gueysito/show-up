"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatEther } from "ethers";
import { v1NftMaximumGasWei } from "../../domain/v1-nft-budget";
import type { readV1NftState } from "../../server/events/v1-nft";
import { JourneyStatus } from "./journey-status";
type View = Awaited<ReturnType<typeof readV1NftState>>;
type Wallet = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
export function V1NftPrize({
  eventId,
  active = true,
  onPublicationReady,
}: {
  eventId: string;
  active?: boolean;
  onPublicationReady?: (ready: boolean) => void;
}) {
  const [view, setView] = useState<View | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [consent, setConsent] = useState(false),
    [submission, setSubmission] = useState<"nft" | "gas" | "return" | null>(null);
  async function post(operation: string, extra: object = {}) {
    const response = await fetch("/api/events/nft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, eventId, operationId: crypto.randomUUID(), ...extra }),
      }),
      result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "NFT status unavailable. Check the original transaction.");
    return result;
  }
  const read = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`/api/events/nft?event=${eventId}`, {
        cache: "no-store",
        signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Create the event escrow first, then check its NFT custody.",
        );
      if (!signal?.aborted) setView(result);
    },
    [eventId],
  );
  const watch =
    Boolean(
      submission ||
      view?.publicationPending ||
      view?.releaseQueued ||
      (view?.signatureState &&
        !["delivered", "failed"].includes(view.delivery) &&
        view.signatureState !== "unresolved") ||
      (view?.status === "draft" &&
        (view.held ||
          view.progress?.confirmations ||
          view.payments.some((payment) => payment.transactionUrl))),
    ) && !["delivered", "failed"].includes(view?.delivery);
  useEffect(() => {
    if (!watch || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await read(controller.signal);
      } catch {
        // Keep the last observed state. The manual check can surface an error.
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 15000);
    }
    timer = setTimeout(poll, 15000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [busy, read, watch]);
  const publicationReady = Boolean(
    view?.status === "draft" &&
    !view.publicationPending &&
    view.progress &&
    view.progress.confirmations >= 2 &&
    view.progress.gasConfirmations >= 2,
  );
  useEffect(() => onPublicationReady?.(publicationReady), [onPublicationReady, publicationReady]);
  async function check() {
    setBusy(true);
    setMessage("");
    try {
      await read();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "NFT status unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function pay(purpose: "nft" | "gas") {
    setBusy(true);
    setMessage("");
    let requested = false;
    const marker = `showup.v1.nft-payment:${eventId}:${purpose}`;
    try {
      if (!view?.custody || !consent)
        throw new Error("Review the NFT and its custody address first.");
      const original = localStorage.getItem(marker);
      if (original)
        throw new Error(
          "A wallet request already exists. Check its original transaction before paying again.",
        );
      const result = await post(`prepare_${purpose}`),
        tx = result.transaction,
        expected =
          purpose === "nft"
            ? `0x42842e0e${view.contributor.slice(2).padStart(64, "0")}${view.custody.slice(2).padStart(64, "0")}${BigInt(view.tokenId).toString(16).padStart(64, "0")}`
            : "0x";
      if (
        Date.parse(result.expiresAt) <= Date.now() ||
        tx.chainId !== "0x1" ||
        tx.from !== view.contributor ||
        tx.to !== (purpose === "nft" ? view.collection : view.custody) ||
        tx.data.toLowerCase() !== expected.toLowerCase() ||
        (purpose === "nft" ? BigInt(tx.value) !== 0n : BigInt(tx.value) > v1NftMaximumGasWei) ||
        BigInt(tx.gas) * BigInt(tx.maxFeePerGas ?? tx.gasPrice) > v1NftMaximumGasWei
      )
        throw new Error("NFT payment differs from the reviewed asset, destination or gas limit.");
      const wallet = (window as Window & { ethereum?: Wallet }).ethereum;
      if (!wallet) throw new Error("Open this page in your Ethereum wallet browser to approve.");
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
      if ((await wallet.request({ method: "eth_chainId" })) !== "0x1")
        throw new Error("Choose Ethereum mainnet.");
      const accounts = await wallet.request({ method: "eth_requestAccounts" });
      if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== view.contributor)
        throw new Error("Choose the NFT's saved contributor wallet.");
      localStorage.setItem(marker, "requested");
      requested = true;
      const hash = await wallet.request({ method: "eth_sendTransaction", params: [tx] });
      if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash))
        throw new Error("Check your wallet for the original transaction.");
      localStorage.setItem(marker, hash);
      await post(`source_${purpose}`, { sourceHash: hash });
      setSubmission(purpose);
      setConsent(false);
      setMessage(
        "Original transaction saved. Showup will check it automatically. No additional payment is needed while it confirms.",
      );
      await read().catch(() => {});
    } catch (error) {
      if (requested && (error as { code?: number })?.code === 4001) localStorage.removeItem(marker);
      setMessage(error instanceof Error ? error.message : "Check the original wallet transaction.");
    } finally {
      setBusy(false);
    }
  }
  async function action(operation: string) {
    setBusy(true);
    setMessage("");
    try {
      await post(operation);
      if (operation === "nft_release" || operation === "nft_retry") setSubmission("return");
      else setMessage("Custody creation requested. Check NFT status again in a moment.");
      await read().catch(() => {});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Check the original request.");
    } finally {
      setBusy(false);
    }
  }
  const gasShortfall = view?.progress?.gasShortfall;
  const mayFund =
    view &&
    view.progress &&
    gasShortfall !== "0" &&
    !view.publicationPending &&
    !view.signatureState &&
    !view.releaseQueued &&
    !view.transactionUrl &&
    ["draft", "settled", "cancelled"].includes(view.status);
  const gasPayment = view?.payments.find((payment) => payment.purpose === "gas")?.transactionUrl;
  const initialTransfer =
    view?.status === "draft" &&
    !view.publicationPending &&
    !view.held &&
    !view.progress?.confirmations;
  const nftPayment = view?.payments.find((payment) => payment.purpose === "nft")?.transactionUrl;
  const canTransfer = Boolean(initialTransfer && !nftPayment && submission !== "nft");
  const canFund = Boolean(mayFund && !gasPayment && submission !== "gas" && !initialTransfer);
  const canReturn =
    view &&
    ["settled", "cancelled"].includes(view.status) &&
    !view.signatureState &&
    !view.releaseQueued &&
    submission !== "return" &&
    view.held &&
    gasShortfall === "0";
  return (
    <section
      className="saved-panel"
      aria-label="Ethereum NFT prize"
      style={{ overflowWrap: "anywhere" }}
    >
      <h2>Ethereum NFT prize</h2>
      <button className="secondary-button" type="button" disabled={busy} onClick={check}>
        Check NFT custody and delivery
      </button>
      {view && (
        <>
          <p>
            <a
              href={`https://etherscan.io/nft/${view.collection}/${view.tokenId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {`Token #${view.tokenId}`}
            </a>
          </p>
          <p>{view.collection}</p>
          <p>{`Ethereum custody: ${view.custody ?? "Deriving through the NEAR contract"}.`}</p>
          <p>
            {view.held
              ? "NFT ownership confirmed in custody."
              : `Current confirmed owner: ${view.owner}.`}
          </p>
          {view.status === "draft" && view.custody && (
            <JourneyStatus
              tone={publicationReady ? "confirmed" : "checking"}
              title={
                view.publicationPending
                  ? "NFT publication queued"
                  : publicationReady
                    ? "Ready to confirm and publish"
                    : view.held
                      ? "NFT custody finalized"
                      : view.progress?.confirmations
                        ? "NFT arrived in custody"
                        : nftPayment || submission === "nft"
                          ? "Waiting for the NFT transfer"
                          : "Transfer the NFT into custody"
              }
            >
              {view.publicationPending
                ? "Showup will publish automatically once Ethereum finality and return gas are verified."
                : publicationReady
                  ? "Select Check publication status, then Confirm prize and publish. Showup will finish any remaining Ethereum checks in the background."
                  : view.progress?.confirmations
                    ? `${view.progress.confirmations === 2 ? "2 or more" : "1"} block confirmation${view.progress.confirmations === 2 ? "s" : ""}. ${view.held ? "Review the return gas below." : "Ethereum finality typically takes about 15 minutes. You can continue once custody and return gas both have two confirmations."}`
                    : "After wallet approval, Showup checks the original transfer. You can track it while Ethereum processes it."}
            </JourneyStatus>
          )}
          {view.progress && view.progress.gasConfirmations > 0 && gasShortfall === "0" && (
            <JourneyStatus
              tone={view.progress.gasConfirmations >= 2 ? "confirmed" : "checking"}
              title="Return gas received"
            >
              {view.progress.gasConfirmations >= 2
                ? "Custody has enough ETH for the current return estimate. No top-up needed."
                : "Custody has enough ETH in the latest block. Waiting for one more confirmation."}
            </JourneyStatus>
          )}
          {view.held &&
            !view.progress &&
            !view.releaseQueued &&
            !view.signatureState &&
            !view.publicationPending &&
            ["draft", "settled", "cancelled"].includes(view.status) && (
              <JourneyStatus tone="checking" title="Checking return gas">
                Showup couldn’t verify the balance and fee estimate yet. Check NFT custody and
                delivery again.
              </JourneyStatus>
            )}
          {mayFund && !initialTransfer && (
            <JourneyStatus
              tone={gasPayment || submission === "gas" ? "checking" : "action"}
              title="Return gas needed"
            >
              {gasPayment || submission === "gas"
                ? `Check the original gas payment. If it has finalized, the current shortfall is ${formatEther(gasShortfall!)} ETH. Send only the shortfall to custody, then check again.`
                : `The custody wallet pays the Ethereum fee to send the NFT. The current top-up estimate is ${formatEther(gasShortfall!)} ETH. Review the exact amount in your wallet.`}
            </JourneyStatus>
          )}
          {!view.custody && view.status === "draft" && active && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => action("nft_derive")}
            >
              Retry custody derivation
            </button>
          )}
          {active && view.custody && (canTransfer || canFund) && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {canTransfer
                  ? "I reviewed the NFT and the Ethereum custody address."
                  : "I reviewed the ETH top-up and the Ethereum custody address."}
              </label>
              {canTransfer && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || !consent}
                  onClick={() => pay("nft")}
                >
                  Transfer this NFT into custody
                </button>
              )}
              {canFund && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || !consent}
                  onClick={() => pay("gas")}
                >
                  Fund the custody gas allowance
                </button>
              )}
              {canFund && (
                <p>
                  {`The wallet shows the exact ETH allowance before approval, capped at ${Number(v1NftMaximumGasWei) / 1e18} ETH plus its funding fee. Unused ETH remains at this event's custody address.`}
                </p>
              )}
            </>
          )}
          {canReturn && (
            <JourneyStatus
              tone="action"
              title={
                view.status === "cancelled"
                  ? "Event cancelled. Return the NFT"
                  : "Send the NFT to the winner"
              }
              actions={
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => action("nft_release")}
                >
                  {view.status === "cancelled"
                    ? "Return NFT to contributor"
                    : "Release NFT to the drawn winner"}
                </button>
              }
            >
              {view.status === "cancelled"
                ? `Return token #${view.tokenId} to ${view.contributor}. Showup will sign and send the transfer.`
                : "Showup will sign and send the transfer to the winner's locked Ethereum wallet."}
            </JourneyStatus>
          )}
          {view.delivery === "delivered" ? (
            <JourneyStatus
              tone="confirmed"
              title={view.status === "cancelled" ? "Return finalized" : "NFT delivery finalized"}
            />
          ) : view.delivery === "failed" ? (
            <JourneyStatus tone="blocked" title="NFT transfer failed">
              Check the original Ethereum transaction before taking further action.
            </JourneyStatus>
          ) : view.returnIncluded ? (
            <JourneyStatus tone="confirmed" title="Your NFT is back in your wallet">
              Ethereum finality is pending and can take around 15–20 minutes after inclusion. No
              action needed.
            </JourneyStatus>
          ) : view.signatureState !== "unresolved" &&
            (view.releaseQueued || view.signatureState || submission === "return") ? (
            <JourneyStatus
              tone="checking"
              title={
                view.delivery === "submitted"
                  ? "Waiting for Ethereum to include the NFT transfer"
                  : "Preparing the NFT transfer"
              }
            >
              Showup checks the original transfer automatically. You can leave this page and return
              to check its progress.
            </JourneyStatus>
          ) : null}
          {view.signatureState === "unresolved" && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => action("nft_retry")}
            >
              Retry the original NFT signature
            </button>
          )}
          {view.transactionUrl && (
            <p>
              <a href={view.transactionUrl} target="_blank" rel="noopener noreferrer">
                {view.delivery === "delivered"
                  ? "View confirmed NFT delivery"
                  : "Track the original NFT transaction"}
              </a>
            </p>
          )}
          {view.payments.map(
            (payment) =>
              payment.transactionUrl && (
                <p key={payment.purpose}>
                  <a href={payment.transactionUrl} target="_blank" rel="noopener noreferrer">
                    {`Original ${payment.purpose === "gas" ? "gas funding" : "custody transfer"}`}
                  </a>
                </p>
              ),
          )}
          {view.custody && (
            <p>
              <a
                href={`https://etherscan.io/address/${view.custody}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Track custody on Ethereum
              </a>
            </p>
          )}
          <p>
            <Link href={`/events/${eventId}/manage`} prefetch={false}>
              Event controls and cancellation
            </Link>
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
