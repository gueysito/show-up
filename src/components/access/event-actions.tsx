"use client";

import { useEffect, useRef, useState } from "react";
import { InvitationManager } from "./invitation-manager";
import type { V1PublicationState } from "../../server/events/v1-publication";
import { HostCodeWindowManager } from "./host-code-window";
import { EventValidatorManager } from "./event-validators";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OwnWallet } from "../../server/wallets/service";
import { usdcAtomic } from "../../domain/event-draft";
import { V1NftPrize } from "./v1-nft-prize";

export function EventActions({
  id,
  revision,
  state,
  description,
  changeDescription,
  onSaved,
  busy,
  setBusy,
  dirty,
  mode,
  timeZone,
  onPublicationRequested,
  prize = "0",
  nft = false,
}: {
  id: string;
  revision: number;
  state?: string;
  description: string;
  changeDescription: (value: string) => void;
  onSaved: (revision: number) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  dirty: boolean;
  mode: "digital" | "physical";
  timeZone: string;
  onPublicationRequested: () => void;
  prize?: string;
  nft?: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState<V1PublicationState | null>(null);
  const [wallets, setWallets] = useState<OwnWallet[]>([]);
  const [sponsorWalletId, setSponsorWalletId] = useState("");
  const hasPrize = (usdcAtomic(prize) ?? 0n) > 0n;
  const publicationPending = useRef<{
    operationId: string;
    revision: number;
    sponsorWalletId?: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/wallets", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json();
        const near = (result.wallets as OwnWallet[]).filter((wallet) => wallet.network === "near");
        setWallets(near);
        setSponsorWalletId(near.length === 1 ? near[0].id : "");
      })
      .catch(() => {});
    return () => controller.abort();
  }, [id]);
  async function checkPublication() {
    setBusy(true);
    setReadiness(null);
    try {
      const response = await fetch(`/api/events?publication=${id}&revision=${revision}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Publication check unavailable. Retry.");
      setReadiness(result);
      setStatus(result.message);
      if (result.state === "verified") router.push(`/events/${id}`);
      else if (result.state !== "draft") onPublicationRequested();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Publication check unavailable. Retry.");
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    if (
      publicationPending.current?.revision !== revision ||
      publicationPending.current?.sponsorWalletId !== (hasPrize ? sponsorWalletId : undefined)
    )
      publicationPending.current = {
        operationId: crypto.randomUUID(),
        revision,
        ...(hasPrize && { sponsorWalletId }),
      };
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "publish", id, ...publicationPending.current }),
      });
      const receipt = await response.json();
      if (!response.ok)
        throw new Error(
          receipt.error ?? "Publication was not confirmed. Check status before retrying.",
        );
      setReadiness({
        eventId: id,
        revision,
        state: receipt.state,
        canPublish: false,
        message:
          "Publication requested. Your saved terms are now locked. Check publication status for the original transaction.",
        transactionUrl: null,
      });
      setStatus("Publication requested. Check publication status for confirmation on mainnet.");
      onPublicationRequested();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Publication was not confirmed. Check status before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function fundPrize() {
    setBusy(true);
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "fund-prize",
          operationId: crypto.randomUUID(),
          id,
          revision,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Prize funding is unavailable. Check status before retrying.",
        );
      const url = new URL(result.walletUrl);
      if (
        url.origin !== "https://app.mynearwallet.com" ||
        url.pathname !== "/sign" ||
        new URL(url.searchParams.get("callbackUrl")!).origin !== window.location.origin
      )
        throw new Error("Reopen Showup at its configured address before funding.");
      window.location.assign(url.href);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Check status before funding again.");
    } finally {
      setBusy(false);
    }
  }
  async function confirmPrize() {
    setBusy(true);
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "confirm-prize",
          operationId: crypto.randomUUID(),
          id,
          revision,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "The prize is not confirmed yet. Check again.");
      setReadiness((current) =>
        current ? { ...current, state: result.state, canFund: false } : current,
      );
      setStatus(
        "Prize receipt confirmed. Publication is queued; check status for the final transaction.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Prize confirmation unavailable.");
    } finally {
      setBusy(false);
    }
  }
  const pending = useRef<{ operationId: string; description: string; revision: number } | null>(
    null,
  );
  async function correctDescription() {
    setBusy(true);
    if (pending.current?.description !== description || pending.current.revision !== revision)
      pending.current = { operationId: crypto.randomUUID(), description, revision };
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "copy", id, ...pending.current }),
      });
      const receipt = await response.json();
      if (!response.ok)
        throw new Error(receipt.error ?? "Description correction was not confirmed.");
      onSaved(receipt.revision);
      pending.current = null;
      setStatus("Description correction saved. Published material terms remain locked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Correction was not confirmed. Retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-panel" aria-label="Event publication and access">
      <h2>
        {state === "published"
          ? "Published terms are locked"
          : state === "publication_pending"
            ? "Publication in progress"
            : "Before publication"}
      </h2>
      <p>
        Publishing locks the saved event terms in the NEAR escrow. The project pays network gas.
        Attendee deposits open after the contract confirms publication.
      </p>
      {state !== "published" && (
        <div>
          {hasPrize && (state ?? "draft") === "draft" && (
            <div>
              <label htmlFor={`prize-wallet-${id}`}>Prize funding wallet (USDC on NEAR)</label>
              <select
                id={`prize-wallet-${id}`}
                value={sponsorWalletId}
                disabled={busy}
                onChange={(event) => setSponsorWalletId(event.target.value)}
              >
                <option value="">Choose a verified NEAR wallet</option>
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.address}
                  </option>
                ))}
              </select>
              <p>
                <Link href="/account/wallets" prefetch={false}>
                  Verify a NEAR funding wallet
                </Link>
              </p>
              <p>
                The wallet you choose pays the exact prize and its transfer gas. The project pays
                publication gas.
              </p>
            </div>
          )}
          <button
            type="button"
            className="primary-button"
            disabled={
              busy ||
              dirty ||
              (hasPrize && !sponsorWalletId && (state ?? "draft") === "draft") ||
              (readiness !== null && (!readiness.canPublish || readiness.revision !== revision))
            }
            onClick={publish}
          >
            {hasPrize || nft ? "Create prize event escrow" : "Publish event on mainnet"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || dirty}
            onClick={checkPublication}
          >
            Check publication status
          </button>
          {dirty && <p>Save your changes before checking publication requirements.</p>}
          {!dirty && readiness?.revision === revision && (
            <section aria-label="Saved publication requirements">
              <p>{readiness.message}</p>
              {(readiness.canFund || (nft && readiness.state === "awaiting_prize")) && (
                <div>
                  {readiness.canFund && (
                    <>
                      <p>{`Prize: ${readiness.prizeUsdc} USDC on NEAR. Funding wallet: ${readiness.fundingAddress}.`}</p>
                      <p>
                        The wallet may reserve up to 0.16 NEAR for gas; unused gas is returned. This
                        is separate from the USDC prize.
                      </p>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={busy}
                        onClick={fundPrize}
                      >
                        Approve prize funding in MyNearWallet
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={confirmPrize}
                  >
                    Confirm prize and publish
                  </button>
                </div>
              )}
              {readiness.transactionUrl && (
                <p>
                  <a href={readiness.transactionUrl} target="_blank" rel="noopener noreferrer">
                    View publication transaction
                  </a>
                </p>
              )}
            </section>
          )}
          {status && <p role="status">{status}</p>}
          {nft && <V1NftPrize eventId={id} />}
        </div>
      )}
      {state === "published" && (
        <div>
          <p>
            <Link href={`/events/${id}`} prefetch={false}>
              Open attendee event page
            </Link>
          </p>
          <label htmlFor="copy-description">Correct description only</label>
          <textarea
            id="copy-description"
            disabled={busy}
            value={description}
            maxLength={2000}
            onChange={(event) => changeDescription(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={correctDescription}
          >
            Save description correction
          </button>
          <p role="status">{status}</p>
          <InvitationManager canIssueHost={false} eventId={id} />
          {mode === "digital" && (
            <HostCodeWindowManager key={id} eventId={id} timeZone={timeZone} />
          )}
        </div>
      )}
      {mode === "physical" && (
        <EventValidatorManager
          key={id}
          eventId={id}
          draft={(state ?? "draft") === "draft"}
          dirty={dirty}
        />
      )}
    </section>
  );
}
