# ADR-0006: Bind routed receipts to stored financial consent

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
disabled. External return execution, actual provider receipts, draw/custody proofs
and source qualification remain incomplete.

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
- `src/server/commitments/contract-authorization.ts`

## Verification / guardrails

`contracts/sandbox-tests/tests/routed_funding.rs` exercises all four wallet families
against actual disposable token receipts and original NEAR principal delivery,
plus substitution, source control and receipt-accounting failures.
`scripts/check-routed-funding.ts` independently verifies application signatures,
wire images, quote hashes and principal conservation. These use generated fixture
keys and tokens, never public provider execution or owner keys.
