import { AppFailure } from "../server/http/security";
import { matchesV1Registration } from "../server/commitments/v1-registration";
import { v1Claim, type V1ActionImage } from "../server/events/v1-actions";
import { readV1Record, type V1Snapshot } from "../server/protocol/v1-escrow";
import { record } from "../server/protocol/quote-signature";
import { v1NftCustody } from "../server/protocol/v1-nft";

export async function validateV1Action(
  image: V1ActionImage,
  snapshot: V1Snapshot,
  transport?: typeof fetch,
) {
  if (BigInt(snapshot.block.height) < BigInt(image.minimumHeight))
    throw new Error("V1 action source regressed");
  const event = snapshot.event;
  if (!event || event.id !== image.eventId) throw new Error("V1 action event mismatch");
  if (image.kind.startsWith("nft_")) {
    const nft = record(event.nft);
    if (image.kind === "nft_derive") {
      if (event.status !== "draft" || nft.custody || nft.deriving === true)
        throw new AppFailure(409, "NFT custody is already requested.");
    } else {
      if (!["settled", "cancelled"].includes(String(event.status)))
        throw new AppFailure(409, "Close or cancel the event before releasing its NFT.");
      v1NftCustody(nft);
      if (image.kind === "nft_retry") {
        const request = record(nft.request);
        if (
          request.state !== "unresolved" ||
          request.attempt !== Number(image.target.split(":")[1])
        )
          throw new AppFailure(409, "The original signing attempt changed.");
      } else {
        const winner = event.status === "settled" ? event.winner : null,
          recipient = winner
            ? (await readV1Record("get_registration", String(winner), snapshot.block, transport))
                ?.ethereum
            : nft.contributor;
        if (!image.nft || recipient !== image.nft.recipient || nft.request)
          throw new AppFailure(409, "NFT recipient or original release changed.");
      }
    }
  } else if (image.kind === "withdraw") {
    const claim = v1Claim(
      await readV1Record("get_claim", image.target, snapshot.block, transport),
      image.recipient!,
    );
    if (
      claim.pending ||
      claim.paid !== image.previousPaid ||
      claim.remaining !== image.amount ||
      BigInt(claim.remaining) === 0n
    )
      throw new AppFailure(409, "The original claim changed. Review its payment status.");
  } else {
    if (event.status !== "published" && !(image.kind === "cancel" && event.status === "draft"))
      throw new AppFailure(409, "The event is already closed.");
    if (image.kind === "check_in") {
      if (
        snapshot.block.timestampMs < Number(event.start_ms) ||
        snapshot.block.timestampMs >= Number(event.end_ms)
      )
        throw new AppFailure(409, "The check-in window has ended.");
      const reg = await readV1Record("get_registration", image.target, snapshot.block, transport);
      if (
        !image.registration ||
        !matchesV1Registration(reg, image.registration) ||
        reg!.funded !== true
      )
        throw new AppFailure(409, "The funded registration changed.");
    }
    if (image.kind === "settle" && snapshot.block.timestampMs < Number(event.start_ms))
      throw new AppFailure(409, "The event has not started.");
  }
}
export async function observeV1Action(
  image: V1ActionImage,
  snapshot: V1Snapshot,
  minimumHeight: string,
  transport?: typeof fetch,
) {
  if (
    BigInt(snapshot.block.height) < BigInt(minimumHeight) ||
    BigInt(snapshot.block.height) < BigInt(image.minimumHeight)
  )
    throw new Error("V1 action observation regressed");
  if (!snapshot.event || snapshot.event.id !== image.eventId)
    throw new Error("V1 action event mismatch");
  let confirmed = false;
  if (image.kind.startsWith("nft_")) {
    const nft = record(snapshot.event.nft);
    if (image.kind === "nft_derive") confirmed = Boolean(nft.custody && v1NftCustody(nft));
    else {
      const request = record(nft.request);
      // A recovered callback is a durable signing outcome, never NFT delivery.
      confirmed = ["signed", "unresolved"].includes(String(request.state));
      if (!confirmed) throw new Error("NFT signing callback remains pending");
    }
  } else if (image.kind === "check_in") {
    const reg = await readV1Record("get_registration", image.target, snapshot.block, transport);
    confirmed = Boolean(
      image.registration &&
      matchesV1Registration(reg, image.registration) &&
      reg!.funded === true &&
      reg!.attended === true,
    );
  } else if (image.kind === "withdraw") {
    const claim = v1Claim(
      await readV1Record("get_claim", image.target, snapshot.block, transport),
      image.recipient!,
    );
    if (claim.pending) throw new Error("V1 token callback is still pending");
    confirmed = BigInt(claim.paid) >= BigInt(image.previousPaid!) + BigInt(image.amount!);
  } else confirmed = snapshot.event.status === (image.kind === "settle" ? "settled" : "cancelled");
  return { height: snapshot.block.height, confirmed };
}
