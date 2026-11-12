"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { WalletChallenge, WalletSignature } from "../../server/wallets/proof";
import type { OwnWallet } from "../../server/wallets/service";
import {
  nearMobileApprovalUrl,
  readNearMobileProof,
  startNearMobileProof,
  type NearMobileProofRequest,
} from "./near-mobile-wallet";
import { getMeteorWallet, verifyMeteorWallet } from "./meteor-wallet";
import { connectRabby, type RabbyPrompt } from "./rabby-connect";
import { connectSolanaWallet } from "./solana-wallet-proof";
import {
  evmVerificationMessage,
  announcedEthereumApp,
  appNames,
  injectedRabby,
  mobileWalletUrl,
  type EthereumApp,
  type EthereumProvider,
  type MobileWallet,
} from "./wallet-apps";
import { WalletPicker, networkNames, type WalletApp } from "./wallet-picker";
import { JourneyStatus, type JourneyTone } from "./journey-status";

type ProofRequest = {
  operation: "verify";
  operationId: string;
  challengeId: string;
  proof: WalletSignature;
};
class WalletUiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function retryableSave(error: unknown) {
  return !(error instanceof WalletUiError) || (error.status !== undefined && error.status >= 500);
}

async function post(input: Record<string, unknown>) {
  const response = await fetch("/api/wallets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new WalletUiError(
      result.error ?? "Wallet verification was not confirmed.",
      response.status,
    );
  return result;
}
function encoded(value: Uint8Array) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}

function verifiedTime(value: string) {
  return `Control verified ${new Date(value).toLocaleString("en-US", { timeZone: "UTC" })} UTC`;
}

function returnedProof(challengeId: string, returnEventId?: string): WalletSignature | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  window.history.replaceState(
    null,
    "",
    `/account/wallets${returnEventId ? `?event=${returnEventId}` : ""}`,
  );
  if (
    url.searchParams.get("challenge") !== challengeId ||
    fragment.get("state") !== challengeId ||
    !fragment.get("signature") ||
    !fragment.get("publicKey") ||
    !fragment.get("accountId")
  )
    return null;
  return {
    signature: fragment.get("signature")!,
    publicKey: fragment.get("publicKey")!,
    accountId: fragment.get("accountId")!,
  };
}

export function WalletManager({
  initialWallets,
  returnChallengeId,
  returnEventId,
  initialNetwork,
  openedWallet,
  walletConnectProjectId,
}: {
  initialWallets: OwnWallet[];
  returnChallengeId?: string;
  returnEventId?: string;
  initialNetwork?: WalletChallenge["network"];
  openedWallet?: MobileWallet;
  walletConnectProjectId?: string;
}) {
  const [network, setNetwork] = useState<WalletChallenge["network"]>(
    returnChallengeId ? "near" : (initialNetwork ?? "base"),
  );
  const [nearAccount, setNearAccount] = useState("");
  const [selectedApp, setSelectedApp] = useState<WalletApp | null>(openedWallet ?? null);
  const [nearApproval, setNearApproval] = useState<NearMobileProofRequest | null>(null);
  const launchedNearApproval = useRef<string | null>(null);
  const verifying = useRef(false);
  const [wallets, setWallets] = useState(initialWallets);
  const [removal, setRemoval] = useState<{
    walletId: string;
    operationId: string;
    error?: string;
  } | null>(null);
  const savedWalletsHeading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: JourneyTone; title?: string; text: string } | null>(
    null,
  );
  const [launchLink, setLaunchLink] = useState<{ app: MobileWallet; href: string } | null>(null);
  const [rabbyPrompt, setRabbyPrompt] = useState<RabbyPrompt | null>(null);
  const rabbyAttempt = useRef<AbortController | null>(null);
  const rabbyLink = useRef<HTMLAnchorElement>(null);
  const [retry, setRetry] = useState(false);
  const pending = useRef<ProofRequest | null>(null);
  const [returnReady, setReturnReady] = useState(Boolean(returnChallengeId));
  const returned = useRef<{ id: string; proof: WalletSignature | null } | null>(null);
  const evmProviders = useRef<Partial<Record<EthereumApp, EthereumProvider>>>({});

  useEffect(() => {
    function announced(event: Event) {
      const wallet = announcedEthereumApp(event);
      if (wallet) evmProviders.current[wallet.app] ??= wallet.provider;
    }
    window.addEventListener("eip6963:announceProvider", announced);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", announced);
  }, []);
  useEffect(() => () => rabbyAttempt.current?.abort(), []);
  const checkNearReturn = useEffectEvent(() => {
    if (
      !busy &&
      nearApproval &&
      launchedNearApproval.current === nearApproval.id &&
      document.visibilityState === "visible"
    )
      void verify();
  });
  useEffect(() => {
    if (!nearApproval) return;
    function returned() {
      checkNearReturn();
    }
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [nearApproval]);
  useEffect(() => {
    if (rabbyPrompt && document.visibilityState === "visible") rabbyLink.current?.focus();
  }, [rabbyPrompt]);

  async function save(request: ProofRequest) {
    pending.current = request;
    setRetry(true);
    let wallet: OwnWallet;
    try {
      wallet = await post(request).catch((error: unknown) => {
        if (!retryableSave(error)) throw error;
        setNotice({ tone: "checking", text: "Checking whether your signed proof was saved…" });
        // Replay the exact operation so the server can return its saved receipt.
        return post(request);
      });
    } catch (error) {
      if (retryableSave(error))
        throw new WalletUiError(
          "We couldn’t confirm the save yet. Tap Retry saving this proof to check again without signing another message.",
        );
      if (error instanceof WalletUiError && error.status !== 429) {
        pending.current = null;
        setRetry(false);
        setReturnReady(false);
      }
      throw error;
    }
    setWallets((old) => [wallet, ...old.filter((item) => item.id !== wallet.id)]);
    pending.current = null;
    setRetry(false);
    setNotice({
      tone: "confirmed",
      title: "Wallet saved",
      text: "Wallet control verified and saved. You can refresh or sign in again to review it.",
    });
  }
  useEffect(() => {
    if (!returned.current && returnChallengeId)
      returned.current = {
        id: returnChallengeId,
        proof: returnedProof(returnChallengeId, returnEventId),
      };
  }, [returnChallengeId, returnEventId]);

  async function refresh() {
    setBusy(true);
    try {
      const response = await fetch("/api/wallets", {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok) throw new WalletUiError(result.error ?? "Saved wallets unavailable.");
      setWallets(result.wallets);
      setNotice({ tone: "confirmed", text: "Saved wallet list refreshed." });
    } catch {
      setNotice({
        tone: "blocked",
        text: "Saved wallets could not be refreshed. Retry when connected.",
      });
    } finally {
      setBusy(false);
    }
  }
  async function removeWallet() {
    if (!removal || busy || verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const { walletId } = await post({
        operation: "remove",
        operationId: removal.operationId,
        walletId: removal.walletId,
      });
      if (walletId !== removal.walletId) throw new Error("Unexpected wallet removal receipt.");
      setWallets((old) => old.filter((wallet) => wallet.id !== walletId));
      setRemoval(null);
      setNotice({ tone: "confirmed", text: "Wallet removed from your Showup account." });
      savedWalletsHeading.current?.focus();
    } catch (error) {
      setRemoval({
        ...removal,
        error:
          error instanceof WalletUiError
            ? error.message
            : "Wallet removal could not be confirmed. Try again.",
      });
    } finally {
      verifying.current = false;
      setBusy(false);
    }
  }
  function openMobileWallet(app: MobileWallet) {
    if (openedWallet === app)
      throw new WalletUiError(
        `Showup couldn’t connect to ${appNames[app]} in this browser. Open Showup inside the wallet app, unlock it, then try again.`,
      );
    const href = mobileWalletUrl(app, window.location.origin, network, returnEventId);
    setLaunchLink({ app, href });
    if (app === "phantom") window.location.assign(href);
  }

  async function verify(app = selectedApp) {
    if (verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setNotice(null);
    setLaunchLink(null);
    let rabby: Awaited<ReturnType<typeof connectRabby>> | undefined;
    try {
      if (pending.current) {
        await save(pending.current);
        setReturnReady(false);
        return;
      }
      if (nearApproval) {
        let proof: Awaited<ReturnType<typeof readNearMobileProof>>;
        try {
          proof = await readNearMobileProof(nearApproval);
        } catch {
          throw new WalletUiError(
            "Could not read the NEAR Mobile approval. Check the same request again.",
          );
        }
        if (proof === "pending") {
          setNotice({ tone: "action", text: "Waiting for you to approve in NEAR Mobile." });
          return;
        }
        setNearApproval(null);
        if (typeof proof === "string")
          throw new WalletUiError("The NEAR Mobile request was closed. Start a new verification.");
        await save({
          operation: "verify",
          operationId: crypto.randomUUID(),
          challengeId: nearApproval.challengeId,
          proof,
        });
        return;
      }
      if (returnReady) {
        if (!returned.current && returnChallengeId)
          returned.current = {
            id: returnChallengeId,
            proof: returnedProof(returnChallengeId, returnEventId),
          };
        if (!returned.current?.proof)
          throw new WalletUiError(
            "The wallet did not return a complete matching proof. Start a fresh verification.",
          );
        await save({
          operation: "verify",
          operationId: crypto.randomUUID(),
          challengeId: returned.current.id,
          proof: returned.current.proof,
        });
        setReturnReady(false);
        return;
      }
      let address: string;
      let ethereum: EthereumProvider | undefined;
      let solana: Awaited<ReturnType<typeof connectSolanaWallet>> = null;
      if (network === "near") {
        if (app === "meteor") {
          const accounts = await (
            await getMeteorWallet()
          )
            .signIn({ network: "mainnet" })
            .catch(() => {
              throw new WalletUiError(
                "Meteor couldn’t connect. Open it, unlock it, and choose your NEAR account.",
              );
            });
          if (accounts.length !== 1 || !accounts[0].accountId)
            throw new WalletUiError("Choose one NEAR account in Meteor to verify.");
          address = accounts[0].accountId;
        } else {
          address = nearAccount.trim();
          if (!address) throw new WalletUiError("Enter the account shown in NEAR Mobile.");
        }
      } else if (network === "solana") {
        try {
          solana = await connectSolanaWallet();
        } catch {
          throw new WalletUiError(
            "Could not connect to your Solana account. Reopen your wallet and retry.",
          );
        }
        if (!solana) return openMobileWallet("phantom");
        address = solana.address;
      } else {
        if (app !== "rabby") return;
        ethereum = evmProviders.current[app] ?? injectedRabby();
        if (ethereum) {
          const accounts = await ethereum.request({ method: "eth_requestAccounts" });
          if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
            throw new WalletUiError("Choose an account in your wallet.");
          address = accounts[0];
        } else if (app === "rabby" && walletConnectProjectId && openedWallet !== app) {
          const controller = new AbortController();
          rabbyAttempt.current = controller;
          const tappedOnAndroid =
            /Android/i.test(navigator.userAgent) && navigator.userActivation?.isActive;
          setNotice({ tone: "checking", text: "Preparing a connection to Rabby…" });
          rabby = await connectRabby(
            walletConnectProjectId,
            network,
            AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
            (prompt) => {
              setNotice(null);
              setRabbyPrompt(prompt);
              if (
                tappedOnAndroid &&
                navigator.userActivation?.isActive &&
                document.visibilityState === "visible"
              ) {
                window.location.assign(prompt.href);
              }
            },
          );
          setRabbyPrompt(null);
          setNotice({ tone: "checking", text: "Preparing your verification message…" });
          address = rabby.address;
        } else return openMobileWallet(app);
      }
      const challenge: WalletChallenge = await post({
        operation: "challenge",
        operationId: crypto.randomUUID(),
        network,
        address,
        ...(network === "near" && { nearTransport: app === "meteor" ? "meteor" : "near-mobile" }),
        ...(returnEventId && { returnEventId }),
      });
      if (new URL(challenge.callbackUrl).origin !== window.location.origin)
        throw new WalletUiError("Reopen Showup at its configured address and start again.");
      if (network === "near") {
        if (app === "meteor") {
          let proof: WalletSignature;
          try {
            proof = await verifyMeteorWallet(challenge);
          } catch {
            throw new WalletUiError(
              "Meteor didn’t return a signature for the selected account. Retry and approve the message in Meteor.",
            );
          }
          await save({
            operation: "verify",
            operationId: crypto.randomUUID(),
            challengeId: challenge.id,
            proof,
          });
          return;
        }
        try {
          setNearApproval(await startNearMobileProof(challenge));
        } catch {
          throw new WalletUiError(
            "NEAR Mobile could not prepare the verification. Try again shortly.",
          );
        }
        return;
      }
      let proof: WalletSignature;
      if (solana) {
        try {
          const signature = await solana.signMessage(new TextEncoder().encode(challenge.message));
          if (!(signature instanceof Uint8Array) || signature.length !== 64)
            throw new Error("Invalid Solana signature");
          proof = { signature: encoded(signature) };
        } catch {
          throw new WalletUiError(
            "The Solana wallet did not return a usable signature. Open this page in your wallet browser and try again.",
          );
        }
      } else {
        if (ethereum) {
          const chain = await ethereum.request({ method: "eth_chainId" });
          if (typeof chain !== "string" || BigInt(chain) !== BigInt(challenge.chainId))
            throw new WalletUiError(
              `Switch your wallet to ${networkNames[network]} mainnet, then tap the wallet again. Verification only signs a message.`,
            );
        }
        const signature = rabby
          ? await rabby.sign(challenge)
          : await ethereum!.request({
              method: "personal_sign",
              params: [evmVerificationMessage(challenge.message), address],
            });
        if (rabby) {
          setRabbyPrompt(null);
          setNotice({ tone: "checking", text: "Saving your signed proof…" });
        }
        if (typeof signature !== "string")
          throw new WalletUiError("Your wallet did not return a message signature.");
        proof = { signature };
      }
      await save({
        operation: "verify",
        operationId: crypto.randomUUID(),
        challengeId: challenge.id,
        proof,
      });
    } catch (error) {
      setNotice({
        tone: "blocked",
        text: rabbyAttempt.current?.signal.aborted
          ? "Rabby verification was cancelled. Tap Rabby to start again."
          : error instanceof WalletUiError
            ? error.message
            : pending.current
              ? "Showup could not confirm that your proof was saved. Try saving the same proof again."
              : "Wallet verification didn’t finish. Unlock the wallet, select your account, and approve the message.",
      });
    } finally {
      rabby?.close();
      rabbyAttempt.current = null;
      setRabbyPrompt(null);
      verifying.current = false;
      setBusy(false);
    }
  }
  const checkingApproval =
    nearApproval || returnReady || retry || !selectedApp || selectedApp === "near-mobile";
  return (
    <section className="saved-panel" aria-label="Wallet control">
      <h2>Verify a wallet</h2>
      <WalletPicker
        network={network}
        selectedApp={selectedApp}
        disabled={busy || retry || returnReady || Boolean(nearApproval)}
        onNetwork={(next) => {
          if (next === network) return;
          setNetwork(next);
          setSelectedApp(null);
          setNotice(null);
          setLaunchLink(null);
        }}
        onApp={(app) => {
          setSelectedApp(app);
          setNotice(null);
          setLaunchLink(null);
          if (app !== "near-mobile") void verify(app);
        }}
      />
      {network === "near" &&
        selectedApp === "near-mobile" &&
        !returnReady &&
        !nearApproval &&
        !retry && (
          <div className="field">
            <label htmlFor="near-wallet-account">NEAR account</label>
            <input
              id="near-wallet-account"
              list="saved-near-accounts"
              value={nearAccount}
              disabled={busy}
              onChange={(event) => setNearAccount(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <datalist id="saved-near-accounts">
              {wallets
                .filter((wallet) => wallet.network === "near")
                .map((wallet) => (
                  <option key={wallet.id} value={wallet.address} />
                ))}
            </datalist>
          </div>
        )}
      <p>
        Choose an account in your wallet and sign a message to prove you control it. Verification is
        free.
      </p>
      {launchLink && (
        <JourneyStatus
          tone="action"
          title={`Continue in ${appNames[launchLink.app]}`}
          actions={
            <a className="primary-button" href={launchLink.href}>
              {launchLink.app === "phantom"
                ? "Open Phantom"
                : `Open ${appNames[launchLink.app]} browser`}
            </a>
          }
        >
          {launchLink.app === "phantom"
            ? "If the app didn’t open, unlock it and try the link below."
            : `This opens Showup in ${appNames[launchLink.app]}’s browser. That browser may ask you to sign in to Showup again.`}
        </JourneyStatus>
      )}
      {rabbyPrompt && (
        <JourneyStatus
          key={rabbyPrompt.step}
          tone="action"
          title={rabbyPrompt.step === "connect" ? "Connect Rabby" : "Approve in Rabby"}
          actions={
            <>
              <a className="primary-button" href={rabbyPrompt.href} ref={rabbyLink}>
                {rabbyPrompt.step === "connect" ? "Open Rabby to connect" : "Open Rabby to sign"}
              </a>
              <button
                type="button"
                className="text-button"
                onClick={() => rabbyAttempt.current?.abort()}
              >
                Cancel
              </button>
            </>
          }
        >
          {rabbyPrompt.step === "connect"
            ? "Step 1 of 2. Choose your account in Rabby, approve the connection, then switch back to Showup."
            : "Step 2 of 2. Sign the message in Rabby, then switch back to Showup to see your saved wallet."}
        </JourneyStatus>
      )}
      {busy && !notice && !rabbyPrompt && !removal && (
        <JourneyStatus
          tone={checkingApproval ? "checking" : "action"}
          title={
            checkingApproval ? "Checking wallet approval" : `Approve in ${appNames[selectedApp]}`
          }
        >
          {checkingApproval
            ? selectedApp === "near-mobile" && !nearApproval && !retry
              ? "Preparing the NEAR Mobile request."
              : "Showup is checking your original request."
            : selectedApp === "meteor"
              ? "Approve in Meteor Wallet, then switch back to this Showup tab. Your wallet will save when the signature arrives."
              : selectedApp
                ? `Approve in ${appNames[selectedApp]}. Showup saves your wallet when the signature arrives.`
                : "Checking your wallet approval…"}
        </JourneyStatus>
      )}
      {returnReady && !busy && (
        <JourneyStatus tone="action" title="Finish wallet verification">
          Your wallet returned to Showup. Finish verification to check and save its proof.
        </JourneyStatus>
      )}
      {nearApproval && !busy && (
        <JourneyStatus
          tone="action"
          title="Approve in NEAR Mobile"
          actions={
            <a
              className="primary-button"
              href={nearMobileApprovalUrl(nearApproval.id)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                launchedNearApproval.current = nearApproval.id;
              }}
            >
              Open NEAR Mobile
            </a>
          }
        >
          Approve the message in NEAR Mobile, then switch back to this Showup tab. We’ll check the
          same request when you return. You can also tap Check NEAR Mobile approval below.
        </JourneyStatus>
      )}
      {notice && !(nearApproval && notice.tone === "action") && (
        <JourneyStatus
          tone={notice.tone}
          title={
            notice.title ??
            (notice.tone === "confirmed"
              ? "Wallet list updated"
              : notice.tone === "blocked"
                ? "Wallet needs attention"
                : "Checking wallet approval")
          }
        >
          {notice.text}
        </JourneyStatus>
      )}
      <div className="saved-actions">
        {(retry || returnReady || nearApproval || selectedApp === "near-mobile") && (
          <button className="secondary-button" disabled={busy} onClick={() => void verify()}>
            {busy
              ? "Checking wallet…"
              : retry
                ? "Retry saving this proof"
                : returnReady
                  ? "Finish NEAR wallet verification"
                  : nearApproval
                    ? "Check NEAR Mobile approval"
                    : "Prepare NEAR Mobile verification"}
          </button>
        )}
        {(retry || returnReady || nearApproval) && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              pending.current = null;
              setRetry(false);
              setReturnReady(false);
              setNearApproval(null);
              setNotice(null);
            }}
          >
            Start a new wallet challenge
          </button>
        )}
        <button className="text-button" disabled={busy} onClick={refresh}>
          Refresh saved wallets
        </button>
      </div>
      <h2 ref={savedWalletsHeading} tabIndex={-1}>
        Saved wallets
      </h2>
      {wallets.length ? (
        <ul>
          {wallets.map((wallet) => (
            <li key={wallet.id}>
              <strong>{networkNames[wallet.network]}</strong>
              <p style={{ overflowWrap: "anywhere" }}>{wallet.address}</p>
              <p>
                <time dateTime={wallet.verifiedAt}>{verifiedTime(wallet.verifiedAt)}</time>
              </p>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                id={`remove-wallet-${wallet.id}`}
                aria-label={`Remove wallet ${networkNames[wallet.network]} ${wallet.address}`}
                aria-expanded={removal?.walletId === wallet.id}
                onClick={() =>
                  setRemoval(
                    removal?.walletId === wallet.id
                      ? null
                      : { walletId: wallet.id, operationId: crypto.randomUUID() },
                  )
                }
              >
                Remove wallet
              </button>
              {removal?.walletId === wallet.id && (
                <div
                  role="group"
                  aria-label={`Remove ${networkNames[wallet.network]} wallet ${wallet.address}`}
                >
                  <JourneyStatus
                    tone={busy ? "checking" : "action"}
                    title={busy ? "Removing wallet" : "Remove this wallet?"}
                    actions={
                      <>
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy}
                          onClick={() => void removeWallet()}
                        >
                          Confirm removal
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            setRemoval(null);
                            document.getElementById(`remove-wallet-${wallet.id}`)?.focus();
                          }}
                        >
                          Keep wallet
                        </button>
                      </>
                    }
                  >
                    This wallet will be removed from future wallet selections. Existing payouts keep
                    their original destination.
                  </JourneyStatus>
                  {removal.error && (
                    <JourneyStatus tone="blocked" title="Wallet removal needs attention">
                      {removal.error}
                    </JourneyStatus>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No wallet control has been verified for this account.</p>
      )}
    </section>
  );
}
