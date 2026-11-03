import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";

// Public event references only. Invitation capabilities retain their existing
// encrypted cookie flow; arbitrary origins, queries and fragments never redirect.
export function eventLoginReturn(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length !== 44 ||
    !value.startsWith("/events/") ||
    !isUuid(value.slice(8))
  )
    throw new AppFailure(400, "Choose a Showup event before signing in.");
  return value;
}
