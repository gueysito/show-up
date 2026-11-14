# ADR-0006: Bind routed receipts and returns to financial consent

## Decision

Allocate an opaque registration reference before requesting a quote. Quote the
short `routed_commitment` message, then bind its authenticated quote hash in the
source wallet's financial consent. Store the original authorization in escrow
before accepting a routed token receipt. This implements existing P2/G1 locally;
it does not change its acceptance criteria or qualify a public route. This local
implementation decision is within the owner's approved P2 work; public activation
and spending still require their separately bounded approval.

## Context

The direct native receiver carries the full authorization inside `ft_transfer_call`.
Routing that entire envelope would couple the provider message to a consent which
itself includes the quote hash. The provider's signed field selection also allows
the wet response deadline to overwrite the echoed request deadline. Eligibility
credentials, wallet control, quote authentication and actual escrow receipt are
separate authorities.

## Invariants

- Frozen event rules include the routing sender, quote key and all four asset and
  network identities. This prototype permits that policy only in the sandbox domain.
- `reserve_routed` requires the credential authority and the original source-wallet
  financial signature: NEP-413 for NEAR, EIP-191 for Base/Ethereum, or Ed25519 text
  signing for Solana. NEAR additionally requires the actual source account/key to
  submit reservation. External sources may use a NEAR relayer.
- The authenticated quote fixes exact output, input/fee limits, assets, destination,
  refund address and registration message. Its hash must equal the wallet-signed
  hash. Check the original request deadline independently against wallet consent.
- Only the configured token's callback from the frozen routing sender can use that
  registration. The stored authorization cannot be replaced. Reservation and
  provider status create no funded seat; direct funding cannot bypass this binding.
- Existing receipt accounting handles short, excess, duplicate and late receipts
  against the original refund destination. Failed or unqualified delivery preserves
  debt. Never mark an external refund paid merely because a local receipt arrived.

## Consequences

The short message has no wallet identity or financial envelope. The contract still
stores pseudonymous authorization and wallet destinations, as its native prototype
does; production privacy and deployment qualification remain required. A relayer
cannot alter signed terms. The frozen provider sender remains a trust dependency:
its actual source-to-receipt attribution must pass G1 before real enrollment.
Storage layout changes require a fresh disposable deployment; no public upgrade or
state migration is authorized. Mainnet initialization and public routing remain
disabled. Public return execution, actual provider receipts, draw/custody proofs
and source qualification remain incomplete.

### Bounded return prototype

Optional frozen return policy adds a separate observer profile and one to three
attempts per original principal/refund liability. Only the configured executor can
submit a return. The contract verifies the provider's exact-input quote against
that existing liability, its original destination, positive minimum net, cumulative
fee budget and a fresh bounded deadline. Deposit addresses cannot be reused.
The token transfer and its callback keep the gross amount in flight; successful
dispatch alone cannot settle debt or authorize another send.

The sandbox prototype uses a signed destination witness bound to the immutable
return image and a unique chain/token/transaction/transfer index. Its profile pins
two source labels and operators. Replays cannot settle twice; conflicts and fees
outside original limits preserve pending debt and pause further routing. Witnesses
remain platform-attested. Actual monetary source independence, transaction
correlation and the funded-use trust model still require qualification and explicit
bounded approval; this local prototype does not grant public monetary authority.

A routed refund must return to escrow. In addition to its witness, the pinned
token's balance must cover existing held obligations plus that refund before the
original remaining principal becomes spendable again. A financial version counter
rejects a stale asynchronous balance result after another money operation. At most
three explicit balance checks are allowed; unavailable evidence or exhausted
limits keep debt pending. Fees already consumed are retained across retries and
shared by the registration's principal/refund liabilities. No automatic top-up or
new destination is permitted.

`paid` records gross settled entitlement, including authorized consumed fees.
Return history separates net delivery, refund recovery and fees; refunded principal
remains owed less only those fees. The native-only application observer cannot
interpret this as qualified external delivery. Its routed integration remains work
before live application funding.

The provider currently inserts a one-basis-point service-fee entry even when the
request supplies `appFees: []`; the fresh signed dry read and historical public
fixture agree. The [documented fee schedule](https://docs.near-intents.org/resources/fees)
describes additional authentication-dependent charges. Showup adds no fee recipient;
the compatibility guard permits only the observed provider entry or an empty list.
That unsigned metadata proves no distribution. Signed gross/net bounds and actual
delivery amounts enforce cost; a changed provider schedule requires fresh review.

## Rejected alternatives

- Embedding the full financial consent in its own quote message creates a circular
  hash dependency and needlessly enlarges the provider payload.
- Enrolling from a quote or provider success status lacks actual attributable
  escrow. Accepting arbitrary callback destinations would give the sender new
  financial authority.

## File references

- `contracts/showup/src/routed_funding.rs`
- `contracts/showup/src/funding_signature.rs`
- `contracts/showup/src/financial.rs`
- `contracts/showup/src/routed_return.rs`
- `src/server/commitments/contract-authorization.ts`

## Verification / guardrails

`contracts/sandbox-tests/tests/routed_funding.rs` exercises all four network profiles
against actual disposable token receipts and original NEAR principal delivery,
plus substitution, source control and receipt-accounting failures.
`scripts/check-routed-funding.ts` independently verifies application signatures,
wire images, quote hashes and principal conservation. These use generated fixture
keys and tokens, never public provider execution or owner keys.
Its return cases exercise actual sandbox token dispatch and cash recovery with
explicitly synthetic destination/transaction witnesses. `scripts/check-routed-returns.ts`
independently replays original consent, return images, fee accumulation and cash
plus in-flight conservation. These do not prove destination-chain delivery.

The read-only `token-transfer-sources.ts` layer now compares registered sources for
pinned USDC NEP-141, ERC-20 and canonical SPL transfers, including legacy/v0 CPI
instructions. It binds inclusion, recipient ownership, amount and a stable transfer
ordinal, keeping self-transfers and refunded/debited receipts from becoming new
delivery credit. Actual retained NEAR deposit/cancellation-return and Base Sepolia
self-transfer reads match two sources; Ethereum and SPL variations have offline
fixtures. Provider-route causality, monetary source qualification and application
reconciliation remain separate gates, and every result keeps funding disallowed.
