"use client";
import { useState } from "react";
import Link from "next/link";
import { v1NftMaximumGasWei } from "../../domain/v1-nft-budget";
import type { readV1NftState } from "../../server/events/v1-nft";
type View = Awaited<ReturnType<typeof readV1NftState>>;
type Wallet = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
export function V1NftPrize({ eventId, active = true }: { eventId: string; active?: boolean }) {
  const [view, setView] = useState<View | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [consent, setConsent] = useState(false);
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
  async function check() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/events/nft?event=${eventId}`, { cache: "no-store" }),
        result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Create the event escrow first, then check its NFT custody.",
        );
      setView(result);
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
      if (localStorage.getItem(marker))
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
      await post(`source_${purpose}`, { sourceHash: hash });
      setMessage(
        "Original transaction saved. Wait for Ethereum finality, then check custody. Do not send again.",
      );
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
      setMessage("Request saved. Check NFT status for its original result.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Check the original request.");
    } finally {
      setBusy(false);
    }
  }
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
          <p>
            {`Event: ${view.status}. Signing: ${view.signatureState ?? "not requested"}. Delivery: ${view.delivery ?? "not submitted"}.`}
          </p>
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
          {active && view.custody && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                {`I reviewed the exact NFT, Ethereum mainnet custody and gas allowance. Cancellation returns the NFT to ${view.contributor}.`}
              </label>
              {view.status === "draft" && !view.held && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || !consent}
                  onClick={() => pay("nft")}
                >
                  Transfer this NFT into custody
                </button>
              )}
              {!view.transactionUrl && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || !consent}
                  onClick={() => pay("gas")}
                >
                  Fund the custody gas allowance
                </button>
              )}
              <p>
                {`The wallet shows the exact ETH allowance before approval, capped at ${Number(v1NftMaximumGasWei) / 1e18} ETH plus its funding fee. Unused ETH remains at this event's custody address.`}
              </p>
            </>
          )}
          {["settled", "cancelled"].includes(view.status) && !view.signatureState && (
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
          )}
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
