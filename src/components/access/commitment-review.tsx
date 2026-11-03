"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";
import { formatUsdc } from "../../domain/event-draft";
import type { OwnWallet } from "../../server/wallets/service";
import type { CommitmentReview } from "../../server/commitments/review";

type WalletSelection = { source: string; refund: string; payout: string };
const purposes = ["source", "refund", "payout"] as const;
const emptySelection = (): WalletSelection => ({ source: "", refund: "", payout: "" });
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}
function storedSelection(key: string | null): string | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 512) return null;
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join() !== "expiresAt,payout,refund,source" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      purposes.some((purpose) => typeof value[purpose] !== "string" || value[purpose].length > 36)
    )
      return null;
    return raw;
  } catch {
    return null;
  }
}
function restoreSelection(raw: string | null, wallets: OwnWallet[]): WalletSelection {
  const selection = emptySelection();
  if (!raw) return selection;
  const value = JSON.parse(raw) as WalletSelection;
  for (const purpose of purposes)
    if (wallets.some((wallet) => wallet.id === value[purpose])) selection[purpose] = value[purpose];
  const source = wallets.find((wallet) => wallet.id === selection.source),
    refund = wallets.find((wallet) => wallet.id === selection.refund);
  if (!source || source.network !== refund?.network) selection.refund = "";
  return selection;
}

export function CommitmentWalletReview({
  eventId,
  rulesHash,
  wallets,
  selectionScope,
}: {
  eventId: string;
  rulesHash: string;
  wallets: OwnWallet[];
  selectionScope?: string;
}) {
  const storageKey = selectionScope ? `showup.commitment-choices.v1:${selectionScope}` : null;
  const readSelection = useCallback(() => storedSelection(storageKey), [storageKey]);
  const savedSelection = useSyncExternalStore(subscribe, readSelection, () => null);
  const [editedSelection, setSelection] = useState<WalletSelection | null>(null);
  const selection = editedSelection ?? restoreSelection(savedSelection, wallets);
  const [review, setReview] = useState<CommitmentReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const source = wallets.find((wallet) => wallet.id === selection.source);
  function clearSavedSelection() {
    try {
      if (storageKey) sessionStorage.removeItem(storageKey);
    } catch {
      /* Optional tab state. */
    }
  }
  function rememberSelection(event: React.MouseEvent<HTMLAnchorElement>) {
    if (busy) {
      event.preventDefault();
      return;
    }
    // Opaque own-wallet IDs only. Never retain an address, quote, signature,
    // financial approval or payment instruction in browser storage.
    try {
      if (storageKey && Object.values(selection).some(Boolean))
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ ...selection, expiresAt: Date.now() + 30 * 60_000 }),
        );
    } catch {
      /* Wallet verification remains available when tab storage is blocked. */
    }
  }
  function choose(purpose: keyof typeof selection, id: string) {
    clearSavedSelection();
    setReview(null);
    setError("");
    setSelection({
      ...selection,
      [purpose]: id,
      ...(purpose === "source" ? { refund: "" } : {}),
    });
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelection(selection);
    clearSavedSelection();
    setBusy(true);
    setReview(null);
    setError("");
    try {
      const response = await fetch("/api/commitments/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, rulesHash, wallets: selection }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "Review unavailable. Reopen this event and retry.");
      setReview(result);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.name !== "TimeoutError"
          ? failure.message
          : "Review was not completed. Retry when connected.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Wallet and fee review" className="saved-panel">
      <h2>Choose your wallets</h2>
      <p>
        Source refunds return on the source network. Principal delivery uses the payout wallet you
        review separately. Wallet control does not approve a deposit.
      </p>
      <p>
        <Link
          href={`/account/wallets?event=${eventId}`}
          prefetch={false}
          onClick={rememberSelection}
          aria-disabled={busy}
        >
          Verify another wallet for this event
        </Link>
      </p>
      {editedSelection === null && savedSelection && Object.values(selection).some(Boolean) && (
        <p role="status">
          Your previous wallet choices were restored. Review them again before financial approval.
        </p>
      )}
      {!wallets.length ? (
        <p>No verified wallets are saved on this account. Verify a wallet before continuing.</p>
      ) : (
        <form onSubmit={submit}>
          {(["source", "refund", "payout"] as const).map((purpose) => (
            <div key={purpose} className="field">
              <label htmlFor={`commitment-${purpose}`}>
                {purpose === "source"
                  ? "Source wallet"
                  : purpose === "refund"
                    ? "Source-refund wallet"
                    : "Principal payout wallet"}
              </label>
              <select
                id={`commitment-${purpose}`}
                value={selection[purpose]}
                required
                disabled={busy || (purpose === "refund" && !source)}
                onChange={(event) => choose(purpose, event.target.value)}
              >
                <option value="">Choose a verified wallet</option>
                {wallets
                  .filter((wallet) => purpose !== "refund" || wallet.network === source?.network)
                  .map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {`Verified wallet · ${wallet.network.toUpperCase()} · ${wallet.address}`}
                    </option>
                  ))}
              </select>
            </div>
          ))}
          <button
            type="submit"
            className="secondary-button"
            disabled={busy || Object.values(selection).some((value) => !value)}
          >
            {busy ? "Reviewing…" : "Review destinations and fee availability"}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {review && (
        <section aria-label="Reviewed commitment destinations" style={{ overflowWrap: "anywhere" }}>
          <h2>Review before financial approval</h2>
          <p>{`${review.title} · ${formatUsdc(BigInt(review.principal))} USDC principal`}</p>
          <dl>
            {(["source", "refund", "payout"] as const).map((purpose) => (
              <div key={purpose}>
                <dt>
                  {purpose === "source"
                    ? "Pay from"
                    : purpose === "refund"
                      ? "Source refund to"
                      : "Principal payout to"}
                </dt>
                <dd>{`${review.wallets[purpose].network.toUpperCase()} · ${review.wallets[purpose].address}`}</dd>
              </div>
            ))}
            <dt>Maximum source amount</dt>
            <dd>Unavailable until a verified quote exists</dd>
            <dt>Source gas, routing and delivery fee limits</dt>
            <dd>Not verified</dd>
            <dt>Minimum net principal delivery</dt>
            <dd>Not verified</dd>
            <dt>Quote expiry</dt>
            <dd>No qualified quote</dd>
            <dt>Registration closes</dt>
            <dd>
              {`${new Intl.DateTimeFormat("en-US", {
                dateStyle: "full",
                timeStyle: "short",
                timeZone: review.timeZone,
              }).format(new Date(review.registrationClosesAt))} (${review.timeZone})`}
            </dd>
          </dl>
          <p role="status">
            Financial approval and deposits remain closed. The escrow recipient and source-to-return
            route must be qualified before a quote can bind these destinations and exact fee limits.
            No seat, signature or payment instruction has been created.
          </p>
          <button type="button" className="primary-button" disabled>
            Approve financial terms · verified quote required
          </button>
          <details>
            <summary>Reviewed rules reference</summary>
            <p>{review.rulesHash}</p>
          </details>
        </section>
      )}
      <p>
        <Link href={`/account/commitments?event=${eventId}`} prefetch={false}>
          Existing authorizations and recovery
        </Link>
      </p>
    </section>
  );
}
