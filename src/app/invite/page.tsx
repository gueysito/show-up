import { AppHeader } from "../../components/app-header";
import { InvitationRedemption } from "../../components/access/invitation-redemption";

export default function InvitePage() {
  return (
    <>
      <AppHeader area={"invite"} />
      <main>
        <h1>Your invitation</h1>
        <InvitationRedemption />
      </main>
    </>
  );
}
