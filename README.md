# Showup

**Turn an RSVP into a refundable commitment.**

Showup makes flaking cost something. RSVP to an in-person event, X Space, or livestream
with a small USDC deposit. Check in live to get it back, plus a share of any no-show
deposits.

Attendees can pay from **NEAR, Solana, Base, or Ethereum**. NEAR Intents routes cross-chain
payments into USDC escrow on NEAR. The host never holds attendee funds or takes a share
of no-show deposits.

> Attendees fund the commitment. Hosts fund the excitement.

## Status

The core V1 flow runs on NEAR mainnet. See [current state](CURRENT_STATE.md) for what
works today and [the plan](docs/plan.md) for V1 progress and the V2 roadmap.
The V1 escrow contract is deployed at
[`showup-dev-14989f.near`](https://nearblocks.io/address/showup-dev-14989f.near).

**Early settlement protection pending deployment.** The live contract currently
allows the authorized host to settle before the scheduled end, which can cause
attendees who haven't checked in to forfeit their deposits. PR #3 adds a restriction
that prevents settlement before the scheduled end and passes automated tests.
Mainnet deployment and verification of this change are pending.
[PR #3](https://github.com/gueysito/show-up/pull/3)

On mainnet, we verified deposits from all four chains and cancellation refunds to NEAR,
[live-code check-in](https://nearblocks.io/txns/HJcPUxbvvigcCnQpNWtZ7X3SdApbVaDTEJvuFhYtm1wM),
and a [2.25 USDC payout](https://nearblocks.io/txns/3DnWt7mZ31a3j2Q3RdVZ9JmZzADSsBLLUFGMiUmAY2pY)
that included the attendee's deposit, a no-show deposit, and the prize. We also verified
[Ethereum NFT delivery to a winner](https://etherscan.io/tx/0xbb8e8c5527abf7a94e01385c128457fc33b138be6fe15f90b1f75b2ba271475f)
and [return to the contributor on cancellation](https://etherscan.io/tx/0x8f19763e82b2f540c062c409b9039caa4ff655267aa7f8288ebd6fd266022e58).
[Full transaction evidence](docs/plan.md#v1-evidence) · [Build and test the contract](docs/setup.md#v1-escrow-build)

## How V1 works

1. **Publish the event.** The host sets the time, deposit, and capacity, then publishes
   to the escrow contract. They can offer a USDC prize, an Ethereum NFT, or both.
2. **Commit to a seat.** The attendee connects a wallet, reviews the deposit and fees,
   and gets a funded seat once USDC reaches escrow.
3. **Catch the live code.** The host chooses when to share it in the room or on air,
   giving attendees a reason to tune in. The code is valid for up to three minutes.
   The host can issue a fresh code to give people another chance to check in.
4. **Settle on NEAR.** The contract returns deposits to the people who checked in and
   splits any no-show deposits among them. If nobody checks in, everyone gets their
   deposit back and there is no prize draw.
5. **Award the prize, if offered.** The contract uses NEAR's on-chain randomness to
   select one winner from the checked-in attendees. NEAR Chain Signatures deliver
   an NFT prize to the winner's verified Ethereum wallet. Payout receipts link to
   their transactions.

## Architecture

- **Web app:** Next.js and TypeScript, PostgreSQL, and a background worker
  ([ADR-0001](docs/adr/0001-application-and-authentication.md)).
- **Escrow contract:** Rust on NEAR (`contracts/showup-v1` for V1; `contracts/showup`
  retains the V2 prototype).
- **Cross-chain deposits:** NEAR Intents 1Click API.
- **Cross-chain prizes:** NEAR Chain Signatures ([ADR-0002](docs/adr/0002-nft-custody.md)).

```mermaid
flowchart LR
  App[Showup web app] --> DB[(PostgreSQL)] --> Worker[Private worker]
  Worker --> Escrow[NEAR escrow]
  Wallets[Base / Solana / Ethereum wallets] --> Intents[NEAR Intents]
  Intents --> Receiving[Registration Intents balance] -->|worker forwards USDC| Escrow
  Near[NEAR USDC wallet] --> Escrow
  Escrow --> Payout[NEAR payout wallet]
  Escrow --> Signer[Chain Signatures] --> NFT[Ethereum NFT custody]
```

## Run it locally

See [setup](docs/setup.md). The home page explains the loop; `/preview` lets anyone
try the V1 rules without saving or funding an event. `/host` uses authenticated host
access, and attendees follow their event's invitation link.
The full product vision is in the [PRD](docs/prd.md).
Project wallet addresses (no keys) are in [development wallets](docs/development-wallets.md).

## Repository checks

Git and Python 3 are required for the repository checks. On each new clone:

```sh
sh .standards/setup-hooks.sh
sh .standards/check-standards.sh
```

Setup activates the commit template and Git checks, preserving any existing
active hooks. See [standards maintenance](.standards/README.md) for scope and provenance.
