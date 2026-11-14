import Link from "next/link";

const areas = { account: "Account", host: "Hosting", attend: "Attending", invite: "Invitation" };

export function AppHeader({ area }: { area: keyof typeof areas }) {
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="Showup home">
        <span className="brand-mark" aria-hidden="true">
          s.
        </span>
        showup
        <span className="brand-dot">®</span>
      </Link>
      <nav className="app-nav" aria-label="Showup">
        <span className="eyebrow">{areas[area]}</span>
        {area === "host" && <Link href="/host">Your events</Link>}
        {area === "attend" && <Link href="/account/commitments">Deposits and refunds</Link>}
        {area !== "account" && <Link href="/account">Account</Link>}
      </nav>
    </header>
  );
}
