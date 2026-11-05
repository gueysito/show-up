import { AppFailure } from "../server/http/security";
import { matchesV1Registration } from "../server/commitments/v1-registration";
import { v1Claim, type V1ActionImage } from "../server/events/v1-actions";
import { readV1Record, type V1Snapshot } from "../server/protocol/v1-escrow";

export async function validateV1Action(
  image: V1ActionImage,
  snapshot: V1Snapshot,
  transport?: typeof fetch,
) {
  if (BigInt(snapshot.block.height) < BigInt(image.minimumHeight))
    throw new Error("V1 action source regressed");
  const event = snapshot.event;
  if (!event || event.id !== image.eventId) throw new Error("V1 action event mismatch");
  if (image.kind === "withdraw") {
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
    if (event.status !== "published") throw new AppFailure(409, "The event is already closed.");
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
  if (image.kind === "check_in") {
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
