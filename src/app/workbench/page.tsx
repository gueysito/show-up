import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { EventDraftForm } from "../../components/event-draft-form";
import { harnessAvailable } from "../../server/harness/guard";

export const dynamic = "force-dynamic";

export default async function Workbench() {
  if (!harnessAvailable()) notFound();
  const requestHeaders = await headers();
  if (requestHeaders.get("host") !== new URL(process.env.SHOWUP_ORIGIN!).host) notFound();
  return <EventDraftForm persistence />;
}
