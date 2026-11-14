# ADR-0002: Contract-governed NFT custody

Status: Accepted design direction for the restricted release, including platform-attested
external observations. Implementation and verification remain pending.

## Decision

Use native NEAR custody for NEP-171 assets. For Base/Ethereum ERC-721 and Solana
Core assets, recommend event-specific addresses controlled by a dedicated NEAR
custody-policy contract through Chain Signatures. The broadcaster has no general
spending key. NFT formats remain the narrow proposed allowlist in the technical
scope; supporting a network does not mean supporting every asset standard.

Keep external observations separate from release authorization. The owner accepted contract-enforced release and the bounded observer model below;
this does not authorize implementation, funding, or an operator custody wallet.

## Context and evidence

The repository contains only requirements, at checkpoint `daca9ed`; no custody code
exists to audit. One NFT supplements the monetary draw prize. Accepted prizes remain
owed; declines, timeout, abort and expiry have separate published outcomes.

The [NEAR signing guide](https://docs.near.org/chain-abstraction/chain-signatures/implementation)
documents deriving addresses, constructing transactions, requesting signatures and
broadcasting for EVM/Solana. The [overview](https://docs.near.org/chain-abstraction/chain-signatures)
explicitly says signing does not establish external-chain state. These sources
support a mechanism to investigate, not verified NFT custody or a security audit.
No general NFT receipt proof spanning all selected chains was established here.

## Concrete protocol

1. Freeze an event prize descriptor: network, standard, collection/mint/asset ID,
   contributor return address, policy version, and custody derivation path. Use a
   path scoped to the deployment, network, event and prize; never reuse addresses.
2. Contributor deposits the precise asset. NEAR verifies its receiver callback and
   ownership natively. External custody confirmation requires the observation policy
   below. Verify transfer restrictions and authorities, not only token metadata.
   Publication is blocked until confirmed; wrong/unsolicited assets are quarantined
   for separately authorized recovery, never advertised or automatically signed out.
3. At draw freeze, retain eligible verified receiving wallets. A valid selected
   attendee can atomically ACCEPT or DECLINE before the common deadline. NEAR owns
   the canonical decision. No external chain independently decides claim expiry.
4. Before the first signature request, NEAR commits an irreversible payout intent:
   exact asset, recipient and operation (winner delivery or contributor return).
   It cannot later sign the competing operation, even if a broadcaster reports
   failure. Signing retries preserve that intent; delivery state is separate.
5. The contract builds or strictly decodes the full allowed transaction. EVM:
   exact chain ID, collection, transfer selector/arguments, source/recipient/token,
   zero arbitrary value, nonce and gas bounds. Solana: exact program IDs, account
   roles, asset/recipient, approved transfer instruction, bounded fee instructions,
   and recent blockhash. No arbitrary calls, approvals, delegate/authority changes,
   or caller-supplied opaque hash signing. NEAR NFT callbacks are private and typed.
6. A worker broadcasts the signature and reconciles finality. Repeated EVM sends
   use replacement semantics for the same nonce and intent; a different nonce
   requires reconciled state. Expired Solana transactions may be rebuilt only for
   the same committed intent after expiry/status reconciliation. Every request,
   fee and retry is budgeted. Never sign an opposite return while an old winner
   transfer may still execute.
7. Mark delivered only on destination evidence. An observation error cannot change
   the committed recipient. Accepted transfers remain recoverable indefinitely;
   retirement of the website does not erase obligations or enable clawback.

## Accepted external-state observation model

Accepted restricted-release model: a dedicated observer attests finalized
NFT ownership and delivery after comparing two independently operated RPC services.
Sign a receipt bound to deployment/network, event, exact asset, custody address,
block/slot and block hash, operation and expiry. Pin observer keys for funded events,
separate them from host/bot/broadcaster keys, and pause on conflicting observations.
Provider independence and chain-specific finality must be checked in implementation.

This is **platform-attested custody evidence**, not trustless verification. Two RPC
queries do not remove trust in the observer. Compromise could falsely mark an
unfunded prize as ready or a transfer as delivered, though the observer must not
select a new beneficiary or authorize arbitrary signatures. False publication and
operational denial remain meaningful risks. The owner accepted this trust boundary for inexpensive, allowlisted NFTs in the
restricted release. Publication still requires implementation and passing security
and integration checks. This is not acceptance of unrestricted public custody.

Alternative: validate external ownership/receipt proofs on NEAR using a verified
cross-chain proof system. Do not assume a fungible-token bridge is a general NFT
state verifier. Proof availability, finality, cost and chain coverage need separate
research and estimates; this option is not included in the effort range below.

## Invariants

- No platform worker has unrestricted spending or signing authority.
- Admin pause stops new risk; it cannot redirect an allocated or accepted prize.
- Freeze code/upgrade authority while funded obligations exist. Remove full-access
  keys that could bypass the signing policy, subject to a reviewed deployment plan.
- Collection upgrade, freeze, permanent delegate and transfer-hook powers must be
  assessed. Reject assets whose external authority can invalidate custody promises.
- MPC participants and network availability remain dependencies. Contract control
  does not mean independent of infrastructure or immune to provider collusion.
- Intent locking prevents accept/return races even with false delivery observations.
- Exact domains, paths, signing algorithms, encodings, versions and deployed IDs
  are verified during implementation, not copied uncritically from examples.

## Consequences and alternatives

This keeps one authoritative prize decision on NEAR and avoids implementing an
independent winner engine on every chain. It still needs distinct EVM/Solana
transaction builders and hostile-input tests. Native-chain vaults with verified
NEAR messages are an alternative if controlled-signing cannot enforce the policy;
they add deployments and do not automatically solve cross-chain evidence.
A platform hot wallet and unrestricted sign-hash endpoint are rejected.

## Verification / guardrails

Before any funded use, prove native deposit, publication, acceptance, decline,
expiry, abort, return, and retry journeys for each required network. Negative tests
must mutate every signed field; attempt cross-event/path/chain replay, arbitrary
calls, admin upgrades, stale callbacks, conflicting terminal transitions, false
observations, signature withholding, expired blockhash and dropped/replaced EVM
transactions. Assert an existing winner signature cannot coexist with a return
signature. Verify contract authority/key removal and recovery before deployment.

This document is a design review only. Authentication, tenant isolation, rate limits,
input handling, secrets, dependency vulnerabilities and public ingress have no
implemented code to inspect. Their security verification is required by the plan.

## File references

- [Product requirements](../prd.md), sections 13–16
- [Technical recommendation](../technical-scope.md#consolidated-technical-recommendation)
- [Build plan](../plan.md#implementation-plan-for-approval)
