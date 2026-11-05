"use client";

import { useEffect, useRef, useState } from "react";
import type { WalletChallenge, WalletSignature } from "../../server/wallets/proof";
import type { OwnWallet } from "../../server/wallets/service";
import {
  nearMobileApprovalUrl,
  readNearMobileProof,
  startNearMobileProof,
  type NearMobileProofRequest,
} from "./near-mobile-wallet";
import { verifyMeteorWallet } from "./meteor-wallet";
import { connectSolanaWallet } from "./solana-wallet-proof";

type EthereumWallet = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
type ProofRequest = {
  operation: "verify";
  operationId: string;
  challengeId: string;
  proof: WalletSignature;
};
class WalletUiError extends Error {}
const labels = { near: "NEAR", base: "Base", ethereum: "Ethereum", solana: "Solana" };

async function post(input: Record<string, unknown>) {
  const response = await fetch("/api/wallets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new WalletUiError(result.error ?? "Wallet verification was not confirmed.");
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
}: {
  initialWallets: OwnWallet[];
  returnChallengeId?: string;
  returnEventId?: string;
}) {
  const [network, setNetwork] = useState<WalletChallenge["network"]>(
    returnChallengeId ? "near" : "base",
  );
  const [nearAccount, setNearAccount] = useState("");
  const [nearWallet, setNearWallet] = useState<"near-mobile" | "meteor">("near-mobile");
  const [nearApproval, setNearApproval] = useState<NearMobileProofRequest | null>(null);
  const [wallets, setWallets] = useState(initialWallets);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [retry, setRetry] = useState(false);
  const pending = useRef<ProofRequest | null>(null);
  const [returnReady, setReturnReady] = useState(Boolean(returnChallengeId));
  const returned = useRef<{ id: string; proof: WalletSignature | null } | null>(null);

  async function save(request: ProofRequest) {
    pending.current = request;
    setRetry(true);
    const wallet: OwnWallet = await post(request);
    setWallets((old) => [wallet, ...old.filter((item) => item.id !== wallet.id)]);
    pending.current = null;
    setRetry(false);
    setNotice({
      error: false,
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
      setNotice({ error: false, text: "Saved wallet list refreshed." });
    } catch {
      setNotice({
        error: true,
        text: "Saved wallets could not be refreshed. Retry when connected.",
      });
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    setBusy(true);
    setNotice(null);
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
          setNotice({ error: false, text: "Waiting for you to approve in NEAR Mobile." });
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
      const injected = window as unknown as {
        ethereum?: EthereumWallet;
      };
      let address: string;
      let ethereum: EthereumWallet | undefined;
      let solana: Awaited<ReturnType<typeof connectSolanaWallet>> = null;
      if (network === "near") {
        address = nearAccount.trim();
        if (!address) throw new WalletUiError("Enter the NEAR account you control.");
      } else if (network === "solana") {
        try {
          solana = await connectSolanaWallet();
        } catch {
          throw new WalletUiError(
            "Could not connect to your Solana account. Reopen your wallet and retry.",
          );
        }
        if (!solana)
          throw new WalletUiError(
            "Open this page in a compatible Solana wallet browser or enable its browser extension.",
          );
        address = solana.address;
      } else {
        ethereum = injected.ethereum;
        if (!ethereum)
          throw new WalletUiError(
            "Open this page in a compatible Ethereum wallet browser or enable its browser extension.",
          );
        const accounts = await ethereum.request({ method: "eth_requestAccounts" });
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string")
          throw new WalletUiError("Choose an account in your wallet.");
        address = accounts[0];
      }
      const challenge: WalletChallenge = await post({
        operation: "challenge",
        operationId: crypto.randomUUID(),
        network,
        address,
        ...(network === "near" && { nearTransport: nearWallet }),
        ...(returnEventId && { returnEventId }),
      });
      if (new URL(challenge.callbackUrl).origin !== window.location.origin)
        throw new WalletUiError("Reopen Showup at its configured address and start again.");
      if (network === "near") {
        if (nearWallet === "meteor") {
          let proof: WalletSignature;
          try {
            proof = await verifyMeteorWallet(challenge);
          } catch {
            throw new WalletUiError(
              "Meteor did not return a signature for this NEAR account. Check your selected account and retry.",
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
        const chain = await ethereum!.request({ method: "eth_chainId" });
        if (typeof chain !== "string" || BigInt(chain) !== BigInt(challenge.chainId))
          throw new WalletUiError(
            `Switch your wallet to ${labels[network]} mainnet, then start verification again. No transaction is requested.`,
          );
        const hex =
          "0x" +
          Array.from(new TextEncoder().encode(challenge.message), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("");
        const signature = await ethereum!.request({
          method: "personal_sign",
          params: [hex, address],
        });
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
        error: true,
        text:
          error instanceof WalletUiError
            ? error.message
            : pending.current
              ? "Showup could not confirm that your proof was saved. Try saving the same proof again."
              : "Wallet verification was not completed. Check your wallet and connection, then retry. No success has been recorded here.",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-panel" aria-label="Wallet control">
      <h2>Verify a wallet</h2>
      <div className="field">
        <label htmlFor="wallet-network">Wallet network</label>
        <select
          id="wallet-network"
          value={network}
          disabled={busy || retry || returnReady || Boolean(nearApproval)}
          onChange={(event) => setNetwork(event.target.value as WalletChallenge["network"])}
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {network === "near" && !returnReady && (
        <div className="field">
          <label htmlFor="near-wallet-app">NEAR wallet app</label>
          <select
            id="near-wallet-app"
            value={nearWallet}
            disabled={busy || retry || Boolean(nearApproval)}
            onChange={(event) =>
              setNearWallet(event.target.value === "meteor" ? "meteor" : "near-mobile")
            }
          >
            <option value="near-mobile">NEAR Mobile</option>
            <option value="meteor">Meteor Wallet</option>
          </select>
          <label htmlFor="near-wallet-account">NEAR account</label>
          <input
            id="near-wallet-account"
            value={nearAccount}
            disabled={busy || retry || Boolean(nearApproval)}
            onChange={(event) => setNearAccount(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      <p>
        NEAR Mobile and Meteor verify a current full-access key. Base/Ethereum use personal message
        signing; contract wallets are not verified in this pilot. Solana uses message signing.
      </p>
      {returnReady && (
        <p role="status">
          Your wallet returned to Showup. Finish verification to check and save its proof.
        </p>
      )}
      {nearApproval && (
        <div>
          <p>Approve the message in your wallet, then return here and check approval.</p>
          <a
            href={nearMobileApprovalUrl(nearApproval.id)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open NEAR Mobile
          </a>
        </div>
      )}
      {notice && (
        <p
          className={notice.error ? "field-error" : undefined}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      <div className="saved-actions">
        <button className="secondary-button" disabled={busy} onClick={verify}>
          {busy
            ? "Checking wallet…"
            : retry
              ? "Retry saving this proof"
              : returnReady
                ? "Finish NEAR wallet verification"
                : nearApproval
                  ? "Check NEAR Mobile approval"
                  : network === "near"
                    ? nearWallet === "meteor"
                      ? "Verify with Meteor Wallet"
                      : "Prepare NEAR Mobile verification"
                    : "Connect and verify wallet"}
        </button>
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
      <h2>Saved wallets</h2>
      {wallets.length ? (
        <ul>
          {wallets.map((wallet) => (
            <li key={wallet.id}>
              <strong>{labels[wallet.network]}</strong>
              <p style={{ overflowWrap: "anywhere" }}>{wallet.address}</p>
              <p>
                <time dateTime={wallet.verifiedAt}>{verifiedTime(wallet.verifiedAt)}</time>
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>No wallet control has been verified for this account.</p>
      )}
    </section>
  );
}
