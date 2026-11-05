"use client";

import { useId, useState } from "react";
import { getMeteorWallet } from "./meteor-wallet";
import {
  nearMobileApprovalUrl,
  readNearMobilePayment,
  startNearMobilePayment,
  type NearMobilePaymentRequest,
  type NearWalletPayment,
} from "./near-mobile-wallet";

type Attempt = { wallet: "meteor" } | ({ wallet: "near-mobile" } & NearMobilePaymentRequest);

function assertWalletPayment(payment: NearWalletPayment) {
  if (
    payment.origin !== window.location.origin ||
    payment.walletTransaction.signerId !== payment.signer ||
    payment.walletTransaction.receiverId !== payment.token ||
    payment.walletTransaction.actions.length !== 1
  )
    throw new Error("Reopen the original Showup event before approving this payment.");
}

export function NearWalletPaymentButton({
  label,
  scope,
  prepare,
  confirm,
  disabled,
}: {
  label: string;
  scope: string;
  prepare(): Promise<NearWalletPayment | { ready: true }>;
  confirm(): Promise<void>;
  disabled?: boolean;
}) {
  const id = useId();
  const [wallet, setWallet] = useState<"near-mobile" | "meteor">("near-mobile");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [showLink, setShowLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const storageKey = `showup.v1.near-wallet:${scope}`;

  function remember(value: Attempt) {
    if (localStorage.getItem(storageKey))
      throw new Error("Another wallet request is already open. Check the original payment status.");
    localStorage.setItem(storageKey, JSON.stringify(value));
    setAttempt(value);
    setShowLink(value.wallet === "near-mobile");
  }

  async function check(active: Attempt) {
    if (active.wallet === "near-mobile") {
      const status = await readNearMobilePayment(active);
      if (status === "rejected") {
        localStorage.removeItem(storageKey);
        setAttempt(null);
        setShowLink(false);
        setMessage("You declined the wallet request. You can start again.");
        return;
      }
      if (status === "pending" && active.expiresAt > Date.now()) {
        setShowLink(true);
        setMessage("The original wallet request is still waiting for approval.");
        return;
      }
      setShowLink(false);
    }
    // The wallet's response is only a hint. The caller reads finalized chain state.
    await confirm();
  }

  async function run() {
    setBusy(true);
    setMessage("");
    try {
      const previous = localStorage.getItem(storageKey);
      if (previous) {
        const stored = JSON.parse(previous) as Attempt;
        if (stored.wallet !== "near-mobile" && stored.wallet !== "meteor")
          throw new Error("The original payment request needs review before trying again.");
        if (stored.wallet === "near-mobile") nearMobileApprovalUrl(stored.id);
        setAttempt(stored);
        await check(stored);
        return;
      }
      if (wallet === "near-mobile") {
        const payment = await prepare();
        if ("ready" in payment) {
          await confirm();
          return;
        }
        assertWalletPayment(payment);
        remember({ wallet, ...(await startNearMobilePayment(payment)) });
        return;
      }
      const payment = await prepare();
      if ("ready" in payment) {
        await confirm();
        return;
      }
      assertWalletPayment(payment);
      const connector = await getMeteorWallet();
      const accounts = await connector.signIn({ network: "mainnet" }).catch(() => {
        throw new Error(
          "Meteor did not connect. Return to Showup and choose the verified NEAR account.",
        );
      });
      if (accounts.length !== 1 || accounts[0].accountId !== payment.signer)
        throw new Error("Choose the verified NEAR account for this payment in Meteor Wallet.");
      // Check the frozen terms again after the wallet account selector.
      const reviewed = await prepare();
      if ("ready" in reviewed) {
        await confirm();
        return;
      }
      assertWalletPayment(reviewed);
      if (reviewed.signer !== accounts[0].accountId)
        throw new Error(
          "The reviewed payment wallet changed. Open the original event and check status.",
        );
      remember({ wallet });
      await connector
        .signAndSendTransaction({ ...reviewed.walletTransaction, network: "mainnet" })
        .catch(() => {
          throw new Error(
            "Meteor did not confirm this request. Check the original payment before trying again.",
          );
        });
      await confirm();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Check the original payment before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      {!attempt && (
        <>
          <label htmlFor={id}>NEAR wallet app</label>
          <select
            id={id}
            value={wallet}
            disabled={busy || disabled}
            onChange={(event) =>
              setWallet(event.target.value === "meteor" ? "meteor" : "near-mobile")
            }
          >
            <option value="near-mobile">NEAR Mobile</option>
            <option value="meteor">Meteor Wallet</option>
          </select>
        </>
      )}
      {attempt?.wallet === "near-mobile" && showLink && (
        <a
          href={nearMobileApprovalUrl(attempt.id)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (attempt.expiresAt > Date.now()) return;
            event.preventDefault();
            setShowLink(false);
            setMessage("This wallet link expired. Check the original payment status.");
          }}
        >
          Open NEAR Mobile to approve
        </a>
      )}
      <button
        type="button"
        className="secondary-button"
        disabled={busy || disabled}
        onClick={() => void run()}
      >
        {attempt ? "Check original wallet approval" : label}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
