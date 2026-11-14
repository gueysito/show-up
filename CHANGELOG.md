# Changelog

## 2026-11-14

- Require the scheduled end before settlement; keep early cancellation as a full-refund path. Recover NFT delivery signatures from the matching saved request and reconcile events closed directly on chain. The contract protection still awaits mainnet deployment, as disclosed in the README.
- Anchor countdowns to server time, build absolute preview-image URLs, and show each attendee their own funding and payout progress on the event page.

- Give every page one visual system: self-hosted type, a sand, ink and blue palette, and status boxes that pair color with a word and a symbol. Add an attendee progress strip, dot-matrix countdowns, a big-screen and read-aloud check-in code, ticket-style receipts, guided empty states and a link preview image.

## 2026-11-13

- Bring Showup V1 to the default branch with mainnet event publication, deposits from four networks, live check-in, settlement, and USDC and Ethereum NFT prizes.
- Guide hosts through NFT funding and returns with transaction links, confirmation status, and the next action. Queue publication after two confirmations and wait for finalized custody before opening deposits.
- Generate Next.js types on clean checkouts and update the contract test dependency `rustix` to 1.1.6.
- Keep the draft editor within narrow screens and save browser test screenshots to Playwright's output directory.
