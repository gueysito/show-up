"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import Image from "next/image";
import { getMeteorWallet } from "./meteor-wallet";
import nearMobileIcon from "./wallet-icons/near-mobile.svg";
import meteorIcon from "./wallet-icons/meteor.svg";
import {
  nearMobileAppUrl,
  readNearMobilePayment,
  startNearMobilePayment,
  type NearMobilePaymentRequest,
  type NearWalletPayment,
} from "./near-mobile-wallet";

type Attempt = { wallet: "meteor" } | ({ wallet: "near-mobile" } & NearMobilePaymentRequest);
type WalletApp = Attempt["wallet"];

function readAttempt(value: string): Attempt {
  const stored = JSON.parse(value) as Attempt;
  if (stored.wallet !== "near-mobile" && stored.wallet !== "meteor")
    throw new Error("The original payment request needs review before trying again.");
  if (stored.wallet === "near-mobile") nearMobileAppUrl(stored.id);
  return stored;
}

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
  scope,
  prepare,
  confirm,
  disabled,
}: {
  scope: string;
  prepare(): Promise<NearWalletPayment | { ready: true }>;
  confirm(): Promise<void>;
  disabled?: boolean;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [showLink, setShowLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const storageKey = `showup.v1.near-wallet:${scope}`;
  const checking = useRef(false);

  function remember(value: Attempt) {
    if (localStorage.getItem(storageKey))
      throw new Error("Another wallet request is already open. Check the original payment status.");
    localStorage.setItem(storageKey, JSON.stringify(value));
    setAttempt(value);
    setShowLink(value.wallet === "near-mobile");
  }

  async function check(active: Attempt, allowExpiredRestart = false) {
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
      if (status === "expired" && allowExpiredRestart && Date.now() >= active.expiresAt + 60_000) {
        // A replacement still requires a fresh server check of the original
        // payment. This builds nothing at the wallet provider and sends no funds.
        const current = await prepare();
        if ("ready" in current) {
          await confirm();
          return;
        }
        localStorage.removeItem(storageKey);
        setAttempt(null);
        setMessage(
          "That wallet request expired and no payment was found. Choose your wallet again.",
        );
        return;
      }
    }
    // The wallet's response is only a hint. The caller reads finalized chain state.
    await confirm();
  }

  const checkOnReturn = useEffectEvent(async (active: Attempt) => {
    if (checking.current || busy || document.visibilityState !== "visible") return;
    checking.current = true;
    try {
      await check(active);
    } catch {
      setMessage("Check the original wallet approval to refresh your payment status.");
    } finally {
      checking.current = false;
    }
  });
  useEffect(() => {
    // Restore a request already opened on this browser before offering a new one.
    const restore = window.setTimeout(() => {
      if (checking.current) return;
      try {
        const previous = localStorage.getItem(storageKey);
        if (!previous) return;
        const stored = readAttempt(previous);
        setAttempt(stored);
        setShowLink(stored.wallet === "near-mobile" && stored.expiresAt > Date.now());
        void checkOnReturn(stored);
      } catch {
        setMessage("The original payment request needs review before trying again.");
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, [storageKey]);
  useEffect(() => {
    if (!attempt) return;
    function returned() {
      if (attempt) void checkOnReturn(attempt);
    }
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", returned);
    return () => {
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", returned);
    };
  }, [attempt]);

  async function run(wallet?: WalletApp) {
    if (checking.current) return;
    checking.current = true;
    setBusy(true);
    setMessage("");
    try {
      const previous = localStorage.getItem(storageKey);
      if (previous) {
        const stored = readAttempt(previous);
        setAttempt(stored);
        await check(stored, true);
        return;
      }
      if (!wallet) throw new Error("Choose your NEAR wallet app.");
      if (wallet === "near-mobile") {
        const payment = await prepare();
        if ("ready" in payment) {
          await confirm();
          return;
        }
        assertWalletPayment(payment);
        const active = await startNearMobilePayment(payment);
        remember({ wallet, ...active });
        // A browser may require a fresh tap by the time both RPCs and the
        // wallet relay have responded. Keep the same request ready below.
        if (navigator.userActivation?.isActive) window.location.assign(nearMobileAppUrl(active.id));
        setMessage("Open NEAR Mobile and approve this payment, then return to Showup.");
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
      checking.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="field">
      {!attempt && (
        <fieldset className="near-wallet-apps" disabled={busy || disabled}>
          <legend>NEAR wallet app</legend>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void run("near-mobile")}
          >
            <Image src={nearMobileIcon} alt="" width={24} height={24} unoptimized />
            NEAR Mobile
          </button>
          <button type="button" className="secondary-button" onClick={() => void run("meteor")}>
            <Image src={meteorIcon} alt="" width={24} height={24} unoptimized />
            Meteor Wallet
          </button>
        </fieldset>
      )}
      {attempt?.wallet === "near-mobile" && showLink && (
        <a
          className="secondary-button"
          href={nearMobileAppUrl(attempt.id)}
          onClick={(event) => {
            if (attempt.expiresAt > Date.now()) return;
            event.preventDefault();
            setShowLink(false);
            setMessage("This wallet link expired. Check the original payment status.");
          }}
        >
          Open NEAR Mobile
        </a>
      )}
      {attempt && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy || disabled}
          onClick={() => void run()}
        >
          Check original wallet approval
        </button>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
