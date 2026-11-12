"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatUsdc } from "../../domain/event-draft";
import { JourneyStatus } from "./journey-status";
import Image from "next/image";
import rabbyIcon from "./wallet-icons/rabby.svg";
import { connectRabbyPayment, type RabbyPrompt } from "./rabby-connect";
import {
  announcedEthereumApp,
  appNames,
  injectedRabby,
  mobileWalletPageUrl,
  type EthereumApp,
  type EthereumProvider,
  type MobileWallet,
} from "./wallet-apps";
import {
  readV1SolanaWallets,
  subscribeV1SolanaWallets,
  noV1SolanaWallets,
  approveV1SolanaPayment,
} from "./v1-solana-wallet";

export type V1RouteSummary = {
  network: string;
  inputAtomic: string;
  principalAtomic: string;
  routingCostAtomic: string;
  expiresAt: string;
  providerDeadline?: string;
  depositAddress: string;
  hint?: string;
  sourceHash?: string | null;
};
const attemptEvent = "showup-v1-source-attempt";
function subscribeAttempts(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(attemptEvent, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(attemptEvent, callback);
  };
}
export function V1RouteReview({
  registrationId,
  eventId,
  network,
  address,
  initial,
  onSubmitted,
  walletConnectProjectId,
}: {
  registrationId: string;
  eventId: string;
  network: string;
  address: string;
  initial?: V1RouteSummary | null;
  onSubmitted: () => void;
  walletConnectProjectId?: string;
}) {
  const [quote, setQuote] = useState<V1RouteSummary | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [submitted, setSubmitted] = useState(false);
  const [prompt, setPrompt] = useState<RabbyPrompt | null>(null);
  const [launchWallet, setLaunchWallet] = useState<MobileWallet | null>(null);
  const [payingWith, setPayingWith] = useState<string | null>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const paying = useRef(false);
  const pairing = useRef<AbortController | null>(null);
  const evmProviders = useRef<Partial<Record<EthereumApp, EthereumProvider>>>({});
  // Opaque registration only. No address, quote or signature is stored here.
  const trackingKey = `showup.v1.source-payment:${registrationId}`;
  const readAttempt = useCallback(() => {
    try {
      return localStorage.getItem(trackingKey) ? "requested" : "clear";
    } catch {
      return "unavailable";
    }
  }, [trackingKey]);
  const tracking = useSyncExternalStore(subscribeAttempts, readAttempt, () => "loading"),
    trackingReady = tracking === "clear";
  const current = quote ?? initial,
    paid = submitted || tracking === "requested" || Boolean(initial?.sourceHash);
  const [solanaWallet, setSolanaWallet] = useState("");
  const readWallets = useCallback(
    () => (network === "solana" ? readV1SolanaWallets() : noV1SolanaWallets),
    [network],
  );
  const subscribeWallets = useCallback(
    (callback: () => void) =>
      network === "solana" ? subscribeV1SolanaWallets(callback) : () => {},
    [network],
  );
  const solanaWallets = useSyncExternalStore(
    subscribeWallets,
    readWallets,
    () => noV1SolanaWallets,
  );
  useEffect(() => {
    if (network === "solana") return;
    function announced(event: Event) {
      const wallet = announcedEthereumApp(event);
      if (wallet) evmProviders.current[wallet.app] ??= wallet.provider;
    }
    window.addEventListener("eip6963:announceProvider", announced);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", announced);
  }, [network]);
  useEffect(() => () => pairing.current?.abort(), []);
  useEffect(() => {
    if (!paid) return;
    function returned() {
      if (document.visibilityState === "visible") onSubmitted();
    }
    returned();
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [onSubmitted, paid]);
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
  async function pay(app?: EthereumApp) {
    if (paying.current || !trackingReady) return;
    const selected =
      solanaWallets.find((wallet) => wallet.name === solanaWallet) ??
      (solanaWallets.length === 1 ? solanaWallets[0] : null);
    const ethereum = app ? (evmProviders.current[app] ?? injectedRabby()) : undefined;
    const useRabbyRelay =
      app === "rabby" && !ethereum && walletConnectProjectId && network !== "solana";
    setError("");
    if (network === "solana" && !selected) {
      if (solanaWallets.length > 1)
        setError("Choose the wallet holding your verified Solana account.");
      else setLaunchWallet("phantom");
      return;
    }
    if (app && !ethereum && !useRabbyRelay) {
      setLaunchWallet(app);
      return;
    }
    paying.current = true;
    setPayingWith(app ? appNames[app] : (selected?.name ?? "your wallet"));
    setBusy(true);
    setLaunchWallet(null);
    let requested = false;
    let rabby: Awaited<ReturnType<typeof connectRabbyPayment>> | undefined;
    function requesting() {
      if (localStorage.getItem(trackingKey))
        throw new Error("A payment was already requested. Check the original deposit status.");
      localStorage.setItem(trackingKey, "requested");
      window.dispatchEvent(new Event(attemptEvent));
      requested = true;
      setSubmitted(true);
    }
    try {
      if (!current || Date.parse(current.expiresAt) <= Date.now())
        throw new Error(
          "This quote expired. Check your original source payment before requesting another.",
        );
      if (network === "solana" && selected) {
        const result = await post("route-pay");
        const hash = await approveV1SolanaPayment(result, current, address, selected, requesting);
        setSubmitted(true);
        onSubmitted();
        await post("source", { sourceHash: hash });
        return;
      }
      if (network !== "base" && network !== "ethereum")
        throw new Error("Choose your source network.");
      const chain = network === "base" ? "0x2105" : "0x1";
      if (useRabbyRelay) {
        const controller = new AbortController();
        pairing.current = controller;
        rabby = await connectRabbyPayment(
          walletConnectProjectId,
          network,
          address,
          AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
          setPrompt,
        ).catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.message.startsWith("Connect the verified deposit account")
          )
            throw error;
          if (error instanceof Error && error.name === "TimeoutError")
            throw new Error(
              "Rabby did not connect in time. Start the connection again from Showup.",
            );
          throw new Error(
            "WalletConnect did not finish connecting to Rabby. Return here to start a fresh connection.",
          );
        });
        setPrompt(null);
      } else if (ethereum) {
        if (BigInt(String(await ethereum.request({ method: "eth_chainId" }))) !== BigInt(chain))
          throw new Error(
            `Switch your wallet to ${network} mainnet, then approve this same quote.`,
          );
        const accounts = await ethereum.request({ method: "eth_requestAccounts" });
        if (
          !Array.isArray(accounts) ||
          !accounts.some(
            (value) => typeof value === "string" && value.toLowerCase() === address.toLowerCase(),
          )
        )
          throw new Error("Choose your verified source account in the wallet.");
      } else throw new Error("Open the wallet browser to approve this payment.");
      setCheckingPayment(true);
      const result = await post("route-pay");
      const token =
        network === "base"
          ? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
          : "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      const tx = result.transaction;
      const expectedData = `0xa9059cbb${current.depositAddress.slice(2).toLowerCase().padStart(64, "0")}${BigInt(current.inputAtomic).toString(16).padStart(64, "0")}`;
      const gasCap = network === "base" ? 20000000000000n : 80000000000000n,
        reserve = network === "base" ? 5000000000000n : 0n;
      if (
        result.network !== network ||
        !(Date.parse(result.expiresAt) > Date.now()) ||
        tx.chainId !== chain ||
        String(tx.from).toLowerCase() !== address.toLowerCase() ||
        String(tx.to).toLowerCase() !== token ||
        tx.value !== "0x0" ||
        typeof tx.data !== "string" ||
        tx.data.toLowerCase() !== expectedData ||
        BigInt(tx.gas) !== 100000n ||
        BigInt(tx.gasPrice) <= 0n ||
        BigInt(tx.gas) * BigInt(tx.gasPrice) + reserve > gasCap ||
        !/^0x(0|[1-9a-f][0-9a-f]{0,15})$/.test(tx.nonce)
      )
        throw new Error("The wallet request differs from your reviewed route.");
      setCheckingPayment(false);
      requesting();
      const params = [
        {
          from: tx.from,
          to: tx.to,
          value: "0x0",
          data: tx.data,
          chainId: chain,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          nonce: tx.nonce,
        },
      ];
      const hash = rabby
        ? await rabby.request(params).catch((failure: unknown) => {
            if ((failure as { code?: number } | null)?.code === 4001)
              throw Object.assign(new Error("You declined the Rabby payment."), { code: 4001 });
            throw new Error("Check the original Rabby payment before trying again.");
          })
        : await ethereum!.request({ method: "eth_sendTransaction", params });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
        throw new Error("Check your wallet activity for the original source transaction.");
      setSubmitted(true);
      onSubmitted();
      await post("source", { sourceHash: hash.toLowerCase() });
    } catch (error) {
      if (requested && (error as { code?: number }).code === 4001) {
        localStorage.removeItem(trackingKey);
        window.dispatchEvent(new Event(attemptEvent));
        setSubmitted(false);
      }
      if (requested && (error as { code?: number }).code !== 4001) {
        setSubmitted(true);
        onSubmitted();
      }
      setError(
        pairing.current?.signal.aborted
          ? "Rabby connection cancelled. Choose a wallet to continue."
          : error instanceof Error
            ? error.message
            : "Wallet approval was not confirmed. Check its activity before retrying.",
      );
    } finally {
      rabby?.close();
      pairing.current = null;
      paying.current = false;
      setPrompt(null);
      setPayingWith(null);
      setCheckingPayment(false);
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
              {network === "solana"
                ? "Up to 0.0025 SOL, including token-account rent"
                : network === "base"
                  ? "0.00002 ETH budget including an L1 reserve; review the wallet's final fee"
                  : "Up to 0.00008 ETH"}
            </dd>
            <dt>Approve before</dt>
            <dd>{new Date(current.expiresAt).toISOString()}</dd>
            {current.providerDeadline && (
              <>
                <dt>Provider deadline for unresolved routing</dt>
                <dd>{new Date(current.providerDeadline).toISOString()}</dd>
              </>
            )}
            <dt>Routing status</dt>
            <dd>{initial?.hint ?? "WAITING_FOR_PAYMENT"}</dd>
          </dl>
          <p>
            The project forwards your converted USDC into escrow and pays the NEAR forwarding gas.
            Your seat is confirmed only after the escrow receives your deposit.
          </p>
          {!paid && !payingWith && !launchWallet && (
            <>
              {network === "solana" && (
                <label>
                  Solana wallet
                  <select
                    value={solanaWallet}
                    onChange={(event) => setSolanaWallet(event.target.value)}
                    disabled={busy}
                    style={{ width: "100%", minWidth: 0 }}
                  >
                    <option value="">
                      {solanaWallets.length === 1
                        ? solanaWallets[0].name
                        : "Choose your Solana wallet"}
                    </option>
                    {solanaWallets.map((wallet) => (
                      <option key={wallet.name} value={wallet.name}>
                        {wallet.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I reviewed the source amount, gas limit, quote expiry and NEAR payout destination.
              </label>
              {network !== "solana" && (
                <p>
                  If Rabby asks to connect, approve the connection and return here. Showup will
                  check the payment, then ask you to approve one USDC transfer in Rabby.
                </p>
              )}
              <JourneyStatus
                tone="action"
                title="Approve the reviewed payment"
                actions={
                  network === "solana" ? (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy || !consent || !trackingReady}
                      onClick={() => void pay()}
                    >
                      Approve source USDC payment
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy || !consent || !trackingReady}
                      onClick={() => void pay("rabby")}
                    >
                      <Image src={rabbyIcon} alt="" width={24} height={24} unoptimized />
                      Approve payment in Rabby
                    </button>
                  )
                }
              />
            </>
          )}
          {paid && !payingWith && !error && (
            <JourneyStatus tone="checking" title="Waiting for on-chain confirmation">
              Checking the original payment and escrow. If it stays pending, tap Check deposit
              status.
            </JourneyStatus>
          )}
        </>
      )}
      {launchWallet && (
        <JourneyStatus
          tone="action"
          title={`Continue in ${appNames[launchWallet]}`}
          actions={
            <>
              <a
                className="primary-button"
                href={mobileWalletPageUrl(
                  launchWallet,
                  new URL(`/account?walletEvent=${eventId}`, window.location.origin),
                )}
              >
                {`Open this event in ${appNames[launchWallet]}`}
              </a>
              <button className="text-button" type="button" onClick={() => setLaunchWallet(null)}>
                Choose another wallet
              </button>
            </>
          }
        >
          {`Continue this event in ${appNames[launchWallet]}’s browser. If it asks you to sign in to Showup, use the account you started with.`}
        </JourneyStatus>
      )}
      {prompt ? (
        <JourneyStatus
          key={prompt.step}
          tone="action"
          title={prompt.step === "connect" ? "1. Connect Rabby" : "2. Approve payment in Rabby"}
          actions={
            <>
              <a className="primary-button" href={prompt.href}>
                {prompt.step === "connect"
                  ? "Open Rabby to connect"
                  : "Open Rabby to approve payment"}
              </a>
              {prompt.step === "connect" && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => pairing.current?.abort()}
                >
                  Cancel connection
                </button>
              )}
            </>
          }
        >
          {prompt.step === "connect"
            ? "Connect your verified deposit account in Rabby, then return here to approve the payment."
            : "Approve the payment in Rabby, then switch back to this Showup tab. We’ll check the original payment."}
        </JourneyStatus>
      ) : (
        payingWith && (
          <JourneyStatus
            tone={paid ? "action" : "checking"}
            title={
              paid
                ? `Approve in ${payingWith}`
                : checkingPayment
                  ? "Checking your payment"
                  : "Starting wallet connection"
            }
          >
            {paid
              ? "Return here after approving to see your deposit status."
              : checkingPayment
                ? "Stay here while Showup checks the amount, wallet balance and network fee. We’ll show the approval link when it’s ready."
                : `Stay here until Showup shows the link to open ${payingWith}.`}
          </JourneyStatus>
        )
      )}
      {error && (
        <JourneyStatus tone="blocked" title="Payment needs attention">
          {error}
        </JourneyStatus>
      )}
      {tracking === "unavailable" && (
        <JourneyStatus tone="blocked" title="Payment tracking unavailable">
          Payment tracking is unavailable in this browser. No wallet approval was requested.
        </JourneyStatus>
      )}
    </section>
  );
}
