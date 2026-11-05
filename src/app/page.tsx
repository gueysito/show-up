import Link from "next/link";

export default function Home() {
  return (
    <>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Showup home">
          <span className="brand-mark" aria-hidden="true">
            s.
          </span>
          <span>showup</span>
          <span className="brand-dot">®</span>
        </Link>
        <Link className="home-sign-in" href="/account" prefetch={false}>
          <span>Your account</span>
          <span aria-hidden="true">↗</span>
        </Link>
      </header>
      <main className="home-main">
        <section className="home-hero" aria-labelledby="home-title">
          <div className="intro">
            <p className="eyebrow">Gather with intention</p>
            <h1 id="home-title">
              Make showing up
              <br />
              <em>mean something.</em>
            </h1>
            <p className="home-description">
              A small, refundable deposit turns “I might” into “I’ll be there.” Show up, check in,
              and get your deposit back.
            </p>
            <div className="home-actions">
              <Link className="primary-button" href="/host" prefetch={false}>
                <span>Host an event</span>
                <span aria-hidden="true">↗</span>
              </Link>
              <Link className="home-preview-link" href="/preview">
                Explore the event rules
              </Link>
            </div>
            <p className="home-attending">
              Joining an event? Open the invitation link your host shared.
            </p>
          </div>
          <aside className="home-receipt" aria-label="Illustrative attendee receipt">
            <div className="home-receipt-heading">
              <span className="eyebrow">You were there.</span>
              <span className="outline-tag">Example receipt</span>
            </div>
            <p className="home-receipt-title">
              A commitment
              <br />
              <em>worth keeping.</em>
            </p>
            <dl className="home-receipt-lines">
              <div>
                <dt>Your deposit, returned</dt>
                <dd>5.00 USDC</dd>
              </div>
              <div>
                <dt>Your share of no-shows</dt>
                <dd>1.00 USDC</dd>
              </div>
              <div className="home-receipt-total">
                <dt>Yours to withdraw</dt>
                <dd>6.00 USDC</dd>
              </div>
            </dl>
            <p className="home-example-note">
              Example: five attendees share one $5 no-show deposit. The host receives no share.
              Network fees are disclosed separately.
            </p>
          </aside>
        </section>
        <section className="home-steps" aria-label="How Showup works">
          <article>
            <span className="eyebrow">01 · Commit</span>
            <h2>Save your seat.</h2>
            <p>
              Review the event rules and deposit. Your money goes into escrow, a contract that holds
              it until the event closes.
            </p>
          </article>
          <article>
            <span className="eyebrow">02 · Show up</span>
            <h2>Be part of it.</h2>
            <p>
              Check in with the host’s live code. Your attendance is confirmed against your funded
              seat.
            </p>
          </article>
          <article>
            <span className="eyebrow">03 · Get it back</span>
            <h2>Good company pays.</h2>
            <p>
              Withdraw your deposit plus an equal share of no-show deposits. An optional host-funded
              prize goes to one drawn attendee.
            </p>
          </article>
        </section>
        <div className="scope-banner home-availability">
          <span className="status-dot" aria-hidden="true" />
          <p>
            USDC deposits on NEAR are live in this private pilot. Base, Solana and Ethereum
            deposits, and Ethereum NFT prizes, are still being verified.
          </p>
        </div>
        <footer className="home-footer">
          <p>Clear rules. No host cut. A reason to be there.</p>
          <a
            href="https://nearblocks.io/address/showup-dev-14989f.near"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>View the mainnet escrow</span>
            <span aria-hidden="true">↗</span>
          </a>
        </footer>
      </main>
    </>
  );
}
