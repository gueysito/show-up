"use client";
import { useState } from "react";
import { formatUsdc } from "../../domain/event-draft";

export type V1RouteSummary = {
  network: string;
  inputAtomic: string;
  principalAtomic: string;
  routingCostAtomic: string;
  expiresAt: string;
  depositAddress: string;
  hint?: string;
  sourceHash?: string | null;
};
type EvmWallet = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
export function V1RouteReview({
  eventId,
  network,
  address,
  initial,
  onSubmitted,
}: {
  eventId: string;
  network: string;
  address: string;
  initial?: V1RouteSummary | null;
  onSubmitted: () => void;
}) {
  const [quote, setQuote] = useState<V1RouteSummary | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [submitted, setSubmitted] = useState(false);
  const current = quote ?? initial,
    paid = submitted || Boolean(initial?.sourceHash);
  async function post(operation: string, extra: object = {}) {
    const response = await fetch("/api/commitments/mainnet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, eventId, operationId: crypto.randomUUID(), ...extra }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error ?? "Routing is unavailable. Check the original payment before retrying.",
      );
    return result;
  }
  async function pricing() {
    setBusy(true);
    setError("");
    try {
      setQuote(await post("quote"));
      setConsent(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Quote unavailable. Retry later.");
    } finally {
      setBusy(false);
    }
  }
  async function pay() {
    setBusy(true);
    setError("");
    let requested = false;
    try {
      if (!current || Date.parse(current.expiresAt) <= Date.now())
        throw new Error(
          "This quote expired. Check your original source payment before requesting another.",
        );
      const result = await post("route-pay");
      const ethereum = (window as Window & { ethereum?: EvmWallet }).ethereum;
      if (!ethereum)
        throw new Error(
          "Open the wallet browser or install your EVM wallet to approve this payment.",
        );
      const chain = network === "base" ? "0x2105" : network === "ethereum" ? "0x1" : null;
      const token =
        network === "base"
          ? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
          : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      const tx = result.transaction;
      if (
        !chain ||
        result.network !== network ||
        tx.chainId !== chain ||
        String(tx.from).toLowerCase() !== address.toLowerCase() ||
        String(tx.to).toLowerCase() !== token ||
        tx.value !== "0x0" ||
        typeof tx.data !== "string" ||
        !/^0xa9059cbb[0-9a-fA-F]{128}$/.test(tx.data) ||
        `0x${tx.data.slice(34, 74)}`.toLowerCase() !== current.depositAddress.toLowerCase() ||
        BigInt(`0x${tx.data.slice(74)}`) !== BigInt(current.inputAtomic) ||
        BigInt(tx.gas) > 100000n
      )
        throw new Error("The wallet request differs from your reviewed route.");
      if (BigInt(String(await ethereum.request({ method: "eth_chainId" }))) !== BigInt(chain))
        throw new Error(`Switch your wallet to ${network} mainnet, then approve this same quote.`);
      const accounts = await ethereum.request({ method: "eth_requestAccounts" });
      if (
        !Array.isArray(accounts) ||
        !accounts.some(
          (value) => typeof value === "string" && value.toLowerCase() === address.toLowerCase(),
        )
      )
        throw new Error("Choose your verified source account in the wallet.");
      requested = true;
      const hash = await ethereum.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: tx.from,
            to: tx.to,
            value: "0x0",
            data: tx.data,
            chainId: chain,
            gas: tx.gas,
            gasPrice: tx.gasPrice,
          },
        ],
      });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
        throw new Error("Check your wallet activity for the original source transaction.");
      setSubmitted(true);
      onSubmitted();
      await post("source", { sourceHash: hash.toLowerCase() });
    } catch (error) {
      if (requested && (error as { code?: number }).code !== 4001) {
        setSubmitted(true);
        onSubmitted();
      }
      setError(
        error instanceof Error
          ? error.message
          : "Wallet approval was not confirmed. Check its activity before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Cross-chain quote review" style={{ overflowWrap: "anywhere" }}>
      <h3>{`${network.toUpperCase()} USDC → NEAR escrow`}</h3>
      <p>
        If routing returns funds before escrow receives them, the source wallet is the refund
        destination. Escrow refunds and event payouts go to your locked NEAR payout wallet.
      </p>
      {!current && (
        <button type="button" className="secondary-button" disabled={busy} onClick={pricing}>
          Get routing quote
        </button>
      )}
      {current && (
        <>
          <dl>
            <dt>Pay from source</dt>
            <dd>{`${formatUsdc(BigInt(current.inputAtomic))} USDC`}</dd>
            <dt>Deposit in NEAR escrow</dt>
            <dd>{`${formatUsdc(BigInt(current.principalAtomic))} USDC`}</dd>
            <dt>Routing cost included above</dt>
            <dd>{`${formatUsdc(BigInt(current.routingCostAtomic))} USDC`}</dd>
            <dt>Source gas is separate</dt>
            <dd>
              {network === "base"
                ? "Up to 0.00002 ETH, including an L1 fee reserve"
                : "Up to 0.00008 ETH"}
            </dd>
            <dt>Quote expires</dt>
            <dd>{new Date(current.expiresAt).toISOString()}</dd>
            <dt>Routing status</dt>
            <dd>{initial?.hint ?? "WAITING_FOR_PAYMENT"}</dd>
          </dl>
          {!paid && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I reviewed the source amount, gas limit, quote expiry and NEAR payout destination.
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !consent}
                onClick={pay}
              >
                Approve source USDC payment
              </button>
            </>
          )}
          {paid && (
            <p role="status">
              Source payment was requested. Check routing and escrow; do not send another payment.
            </p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
