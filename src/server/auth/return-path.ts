import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";

// Public event references only. Invitation capabilities retain their existing
// encrypted cookie flow; arbitrary origins, queries and fragments never redirect.
export function eventLoginReturn(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const eventId =
    typeof value === "string" ? /^\/events\/([^/]+)(?:\/commit)?$/.exec(value)?.[1] : undefined;
  if (typeof value !== "string" || value.trim() !== value || !isUuid(eventId))
    throw new AppFailure(400, "Choose a Showup event before signing in.");
  return value;
}
