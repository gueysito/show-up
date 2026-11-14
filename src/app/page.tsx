import Link from "next/link";
import { CountUp } from "../components/count-up";

const escrow = "https://nearblocks.io/address/showup-dev-14989f.near";
const highlights = [
  "Refundable deposits",
  "No host cut",
  "NEAR · Base · Solana · Ethereum",
  "Check in with a live code",
  "Escrow on NEAR mainnet",
];
const steps = [
  {
    label: "01 / Commit",
    title: "Save your seat.",
    text: "Review the event rules and deposit. Your money goes into escrow, a contract that holds it until the event closes.",
  },
  {
    label: "02 / Show up",
    title: "Be part of it.",
    text: "Check in with the host’s live code. Your attendance is confirmed against your funded seat.",
  },
  {
    label: "03 / Get it back",
    title: "Good company pays.",
    text: "Withdraw your deposit plus an equal share of no-show deposits. An optional host-funded prize goes to one drawn attendee.",
  },
];

function Receipt() {
  return (
    <aside className="home-receipt ticket" aria-label="Illustrative attendee receipt">
      <div className="home-receipt-heading">
        <span className="eyebrow">You were there.</span>
        <span className="outline-tag">Example receipt</span>
      </div>
      <p className="home-receipt-title">
        A commitment
        <br />
        <em>worth keeping.</em>
      </p>
      <p className="ticket-total">
        <span className="dot-number">
          <CountUp from={5} to={6} />
        </span>
        <span>USDC to withdraw</span>
      </p>
      <div className="ticket-tear" aria-hidden="true" />
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
        Example: five attendees share one $5 no-show deposit. The host receives no share. Network
        fees are disclosed separately.
      </p>
      <a className="home-proof" href={escrow} target="_blank" rel="noopener noreferrer">
        Enforced by a contract on NEAR mainnet ↗
      </a>
    </aside>
  );
}

function Hero() {
  return (
    <section className="home-hero" aria-labelledby="home-title">
      <div className="intro">
        <p className="eyebrow">Gather with intention</p>
        <h1 id="home-title">
          Make showing up
          <br />
          <em>mean something.</em>
        </h1>
        <p className="home-description">
          {
            "A small, refundable deposit turns “I might” into “I’ll be there.” Show up, check in, and "
          }
          <strong>get your deposit back.</strong>
        </p>
        <div className="home-actions">
          <Link className="primary-button" href="/host" prefetch={false}>
            <span>Host an event</span>
            <span aria-hidden="true">↗</span>
          </Link>
          <Link className="home-preview-link" href="/preview">
            Try it without a wallet
          </Link>
        </div>
        <p className="home-attending">
          Joining an event? Open the invitation link your host shared.
        </p>
      </div>
      <Receipt />
    </section>
  );
}

function Ticker() {
  return (
    <div className="home-ticker" aria-hidden="true">
      <ul className="home-ticker-track">
        {[...highlights, ...highlights].map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

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
          <span aria-hidden="true">&nbsp;↗</span>
        </Link>
      </header>
      <main className="home-main">
        <div className="home-hero-band">
          <Hero />
        </div>
        <Ticker />
        <div className="home-steps-band">
          <section className="home-steps" aria-label="How Showup works">
            {steps.map((step) => (
              <article key={step.label}>
                <span className="eyebrow">{step.label}</span>
                <h2>{step.title}</h2>
                <p>{step.text}</p>
              </article>
            ))}
          </section>
        </div>
        <div className="home-foot">
          <div className="scope-banner home-availability">
            <span className="status-dot" aria-hidden="true" />
            <p>
              USDC deposits on NEAR are live in this private pilot. Base, Solana and Ethereum
              deposits now work end to end. Ethereum NFT prizes can be delivered to the winner.
            </p>
          </div>
        </div>
        <div className="home-footer-band">
          <footer className="home-footer">
            <p>Clear rules. No host cut. A reason to be there.</p>
            <a href={escrow} target="_blank" rel="noopener noreferrer">
              <span>View the mainnet escrow</span>
              <span aria-hidden="true">↗</span>
            </a>
          </footer>
        </div>
      </main>
    </>
  );
}
