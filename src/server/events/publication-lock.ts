import type pg from "pg";
import { AppFailure } from "../http/security";

export async function requireUnfrozenPublication(client: pg.PoolClient, eventId: string) {
  if (
    (await client.query("SELECT 1 FROM app_publication_images WHERE event_id=$1", [eventId]))
      .rowCount
  )
    throw new AppFailure(
      409,
      "Publication terms are frozen while the contract outcome is reconciled. Duplicate this event for different material terms.",
    );
}
