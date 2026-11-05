# Development wallets and faucet setup

Updated November 4, 2026. Reuse the existing project keys for V1; do not regenerate
them. Mainnet authority and the $50 total budget are in the
[V1 plan](plan.md#mainnet-budget). Fund one wallet at a time and verify arrival.

## Mainnet preparation and initial funding

Public reads on November 4 at 18:31 UTC confirm zero mainnet balances and the
addresses below. The first round is **$11.77 including NEAR USDC**, or $9.23 without
it; it excludes deployment collateral and NFT custody gas. Send directly on the
specified network, native gas first, then Circle USDC. No bridges or exchange
withdrawals are needed for these owner-wallet transfers. Sender transaction fees
are additional; their exact values require the sender's actual wallet quote.

November 4: Solana has finalized **0.003 SOL + 2.54 native USDC**;
Base has finalized **0.00002 ETH + 2.54 native USDC** and Ethereum **0.0001 ETH + 2.54 native
USDC**. Finalized EVM balances were rechecked after NEAR registration.
Official token contracts/mint and all six successful receipts were checked.
[Incoming funds and sender costs](plan.md#mainnet-spend-ledger) are recorded.
NEAR received **0.25 NEAR**, finalized, with the expected sole FullAccess key.
USDC storage registration finalized and both RPCs verified it at block 223087141:
0.00125 NEAR storage deposit, 0.0002389307265016 NEAR transaction fee, and
**0.2485110692734984 NEAR** remaining. Both RPCs subsequently confirmed
**2.549953 native NEAR USDC** at finalized block 223088071, slightly above the
2.54 request. First-round funding is complete on all four networks.
[Registration](https://nearblocks.io/txns/8FR3jtZ8QK2VBjRWbraLsRgUE3Nogy8J9bhDhHR46Wn7).

**Deployment funding is on hold** pending the [predeployment review fixes](plan.md#v1-evidence).
The prior quote was **3.66 native NEAR** to the same implicit controller
address below, about **$14.68** at the quoted $4.01/NEAR. The measured V1 artifact
locks 3.15613 NEAR for code; state/gas reserves and the existing balance determine
the remainder. [Calculation and $50 budget](plan.md#mainnet-budget). Do not fund the
proposed `.near` contract name before account creation is verified. Reprice after fixes.

| Order / exact mainnet | Verified project address | Exact initial amount | Approximate USD |
| --- | --- | --- | --- |
| 1. NEAR mainnet | `14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc` | **0.25 NEAR**, gas and USDC registration only | $1.03 |
| 2. NEAR mainnet, after storage registration | `14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc` | **2.54 USDC**, first deposit/refund test | $2.54 |
| 3. Solana mainnet-beta | `BTXsA7ov3DCLd4yNyK1JpUokk1byw8mSgpGQ6FdGKjKd` | **0.003 SOL + 2.54 USDC** | $2.83 |
| 4. Base mainnet, chain 8453 | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | **0.00002 ETH + 2.54 USDC** | $2.59 |
| 5. Ethereum mainnet, chain 1 | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | **0.0001 ETH + 2.54 USDC** | $2.78 |

CoinGecko snapshot: NEAR $4.12, SOL $95.77, ETH $2,431.92, USDC $0.999597.
Read-only preparation matched all three addresses to local public key fields/bytes;
that preparation accessed no private values and created no signatures. Signature-verified
1Click dry quotes require 2.530950/2.530966/2.530957 USDC from Base/Solana/Ethereum
for 2.50 USDC on NEAR, within each 2.54 allocation. Sample gas prices: Base
0.006 gwei; Ethereum 0.202753314 gwei. Solana sampled priority fees are zero;
its base fee is 5,000 lamports/signature. Quotes are indicative, not payment instructions.

USDC amounts are 2,540,000 atomic units, six decimals. Use only these
[Circle token identities](https://developers.circle.com/stablecoins/usdc-contract-addresses):

- Solana mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Ethereum: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.
- NEAR: `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`.

For Solana, use the wallet's **Send USDC** flow to the project wallet address;
the mint identifies the asset and is not the receiving address. Its associated
token account may need creation. Two public RPCs agree on 1,488,440 lamports
(0.00148844 SOL) rent for a 165-byte token account. That is refundable collateral
only if an empty account can later be closed under its owner's authority, not
a consumed transaction fee. The 0.003 SOL allocation covers a token-account rent
allowance, a system-account balance allowance and bounded transfer fees. Base and
Ethereum have separate balances despite the shared address. The EVM native
allocations are fee reserves, not predicted consumption or permission for retries.

The NEAR address is the exact 32-byte hex encoding of the recorded public key
`ed25519:2PQ8rQ56kQV6dFeiMNwEmbbQvxiTXGFPLt2uk4UyU8cB`. It comes from the prior
public ownership/transfer receipts; no private key was read. Both mainnet RPCs
initially reported `UNKNOWN_ACCOUNT`; the native funding above has now activated
it with freshly verified mainnet key membership. A native NEAR transfer
[activates the implicit account and installs its public key](https://docs.near.org/protocol/tutorials/creating-implicit-and-named-accounts).
Use a plain NEAR send, no memo or function call. Do not send to the testnet name.
Do not send NEAR USDC until token storage is registered and verified. The pinned
mainnet USDC contract reports a 0.00125-NEAR storage minimum on both sources.

The implicit account is suitable as the project funding/controller wallet. It can
hold contract code, but its 64-character ID cannot support the current child-account
layout within NEAR's 64-character account-ID limit. Keeping that layout requires
a short named parent, created through the `near` account's documented factory.
The [unsigned registration proposal](evidence/near-mainnet-account-preparation-2026-11-04.json)
now fixes the candidate name, factory code, original public key and limits below.
No `.near` name is registered or usable as a funding destination yet, and no
testnet tool or credential file has been repointed.

### Pre-V1 account proposal and cost reference

Historical gates and estimates below are superseded by the V1 authority and budget
in the plan. They remain implementation reference, not current instructions.

#### Unsigned named-account registration

The read-only preparer runs without credentials:

```sh
node --import tsx scripts/near-mainnet-account-plan.ts
```

It writes a public-data proposal under `/private/tmp`, never signs, and always
returns `readyToSign: false`. Two registered mainnet sources agree at one finalized
block on factory code `HiyC5tB1gBDpgR4x1guEp1orBde5PXqUYGoWaZfX3JGX`, its downloaded
bytes/hash and its declared [source revision](https://github.com/near/near-linkdrop/tree/9a6bb316f6b7c83b504ce9c94a80c37178097655).
This is source metadata, not an independently reproduced build. Both sources
report the implicit controller and proposed name absent in the saved read.

| Proposal field | Exact bound |
| --- | --- |
| Network / signer | NEAR mainnet / the implicit funding address above |
| Receiver / operation | `near` / one `create_account` call |
| Candidate account | `showup-dev-14989f.near`, unregistered; **do not send funds here** |
| New FullAccess key | The existing public key recorded above |
| Attached principal / tokens / contract deployment | **0 NEAR / none / none** |
| Prepaid gas / maximum purchase price | 100 Tgas / 1,000,000,000 yoctoNEAR per gas unit |
| Total and per-attempt fee cap | **0.102 NEAR**; one signed image, zero write retries |
| Recovery | No principal is advanced. Reconcile the original hash/nonce and complete receipts after uncertainty; never create another image while it can still succeed. No deletion is approved. |

The pinned factory forwards the attached amount and installs the requested key.
[Zero-balance accounts](https://docs.near.org/integrations/accounts) permit the
bare account/key without an initial storage deposit. The current protocol charges
0.007 NEAR for creation through its gas-refund accounting; that is consumed,
not recoverable collateral. Other execution fees still apply. The observed block
gas price is 100,000,000 yoctoNEAR, while the minimum **purchase** price is
1,000,000,000. The preparer uses the latter and conservatively reserves outer
action charges: 0.101202558634721 NEAR, below the 0.102 cap. This is a gas-purchase
upper bound, not a dry execution or predicted consumption. The cap is about $0.39
at the earlier $3.78/NEAR snapshot; it is already within the proposed 0.25 NEAR
wallet allocation, not additional funding. Unused gas refunds remain project funds.

Funded-controller checks require the original sole FullAccess key, no contract or
locked balance, and enough native balance above a conservative storage reserve.
Name, factory, protocol and gas changes stop preparation. Finalized funding,
owner approval of the exact batch and its signing runtime, and fresh pre-signing
checks remain mandatory. Afterwards verify the new zero-balance account and its
key at a common finalized block. Funding/deploying its future child contracts is
a separate priced batch; a zero-balance controller cannot pay that future gas yet.

### Cost and recovery boundaries

The [public preparation receipt](evidence/mainnet-funding-preparation-2026-11-04.json)
preserves chain identities, empty balances, two-source NEAR storage/protocol facts,
two-source Solana rent and nine verified provider-signed dry quotes. Price snapshot:
NEAR $3.78, SOL $91.45, ETH $2,256.47, USDC about $0.999468. These are estimates,
not an exchange-rate promise. EVM gas-price samples were 0.006 gwei on Base and
0.0488694 gwei on Ethereum; the zero-value native transfer estimate was 21,000 gas.
No source-wallet USDC transfer or Base total L1/operator fee was simulated.

| Source | Input quoted for 2.50 USDC in NEAR | Quoted return from 2.50 USDC | Minimum quoted return, 1% tolerance |
| --- | --- | --- | --- |
| Base | 2.530248 USDC | 2.497265 USDC | 2.472292 USDC |
| Solana | 2.530317 USDC | 2.255634 USDC | 2.233077 USDC |
| Ethereum | 2.530240 USDC | 2.199654 USDC | 2.177657 USDC |

The input includes a 1% slippage buffer that may be returned; it is not all fee
consumption. Proposed first-experiment input ceiling is 2.54 USDC per external
network for 2.50 USDC gross principal. Possible return-fee ceilings for review are
0.05 USDC Base, 0.30 USDC Solana and 0.35 USDC Ethereum, leaving positive minimum
net amounts. These are proposed limits, not signed consent, current executable
quotes or per-field authenticated fee details. Requote against the actual deployed
escrow and registered recipient before a bounded approval. No deposit address was
requested. The existing app/contract floor remains 2.50 USDC; signed 1-USDC pricing
does not change it. Rejected 0.10-USDC requests returned higher bridge-minimum hints,
not guaranteed minima. A sequential return can be reused, but fees reduce it;
another full-principal attempt may need a separately priced and approved top-up.

**The complete milestone does not currently fit $10 or $20.** The existing
1,007,612-byte funding-snapshot WASM at `5725e5c` alone requires 10.07612 NEAR of regular code storage collateral,
**$38.09**, at both sources' live 10^19-yoctoNEAR/byte rate. That alone exceeds
$20 by $18.09, excluding state, accounts, gas, stablecoin principal and provider
costs. That artifact also rejects mainnet initialization and external
funding; it is not the final mainnet artifact or a deployment recommendation.
Stripping its 262,158-byte name section would still leave code collateral above
$28 at this price and would require separate artifact verification. The subsequent
local routed-return artifact is 1,208,397 bytes: 12.08397 NEAR, about $45.68,
in code collateral at the same rate/price. SHA-256
`3b74c25b125112ba6902f9c52776fdc7f6899c218eb591e7b205c4e8f4bf1154`;
it remains mainnet-incompatible and was not publicly deployed. Global-contract publication burns more for a new unique deployment,
so it is not a cheaper substitute for this experiment.

Storage collateral stays locked while required data/code remains; current recovery
tools do not release it automatically. Unspent native balances and returned USDC
remain project assets. Gas, actual provider fees and failed-attempt costs are
consumed. The final mainnet artifact, bounded state allowance, key/upgrade authority,
gas/recovery plan, OutLayer execution cost, engineering custody assets/signing and
source qualification still need pricing/verification. **Do not fund the collateral
shortfall yet:** publish the exact additional requirement when those inputs are
known. Keep public deployment/signing gated and all routes disabled.

After owner transfers, verify finalized arrival and exact token/mint/amount before
any approved use, including NEAR FullAccess key membership. A wallet notification,
submitted hash or funding alone grants no execution authority. No automatic top-up
or resend is allowed; uncertain submissions retain their original identity.

## Public addresses

| Network | Public address | Verified state |
| --- | --- | --- |
| NEAR testnet | `showup-dev-14989f.testnet` | Approved reuse deposited 5 test USDC into escrow and returned it through cancellation recovery; driver checks restored at least 20 test USDC. Native balance last observed at the funding stage: 1.731322261486299899999998 test NEAR, before subsequent recovery fees; no final native remeasurement. Child accounts/keys retained. [Receipt](evidence/native-testnet-8529d901-add9-4b0a-9dab-ae9d43142fee.json). |
| Base Sepolia / Ethereum Sepolia | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | Ethereum Sepolia 0.00699987998086555 ETH after native self-transfer, finality pending; Base Sepolia 0.00299941552999982 ETH after finalized native/USDC tests. Last checked test USDC balance: 20 on each chain. |
| Solana devnet | `BTXsA7ov3DCLd4yNyK1JpUokk1byw8mSgpGQ6FdGKjKd` | Ownership and native self-transfer verified; fee-control retest finalized; balance 4.999915 SOL |

The same EVM address can be used on Base and Ethereum mainnets as well as their
test networks; each network has separate assets, balances and gas. The Solana
keypair can control the same address on mainnet, with separate assets/balances.
The named `showup-dev-14989f.testnet` account does not become a mainnet account.
Prepare and verify a mainnet account/address using public key metadata only,
checking whether an implicit or named account supports the actual deployment plan.
Never substitute `.near` for `.testnet` without creating/verifying account control.
EVM derivation used public data only, with empty-input and abc Keccak-256 reference
vectors checked. Rabby signature recovery below independently confirms control of
the selected project address.

## Key storage and backup boundary

The owner generated and backed up all three private keys in 1Password. This is
owner-reported backup completion; no vault contents were inspected. Private files
remain outside the repository in the local `.showup-test-wallets` home directory.
Verified directory permissions 0700 and five files 0600, owned by the local user,
with no extended ACL entries listed. No permissions repair was needed.

These are plaintext local files protected by OS access permissions, not encrypted
wallet keystores. The same macOS user can read them. Do not claim protection from
a compromised user session. Do not make additional plaintext backups, source the
JSON, put keys in CLI arguments, paste them in chat, or commit them. 1Password is
the backup of record; restore verification is performed by the owner in their
terminal/wallet UI. Signing setup is a later bounded operation, not part of this
public-address record. Repo ignore rules are defense in depth, not permission to
move wallet files into the checkout.

## Browser isolation

Use Brave with a dedicated Showup Development Browser user-data directory and
sync disabled. Use only project accounts. Keep personal browser data, wallet
extensions and recovery phrases out of this instance. Browser storage isolation
is not a VM or OS sandbox. Never reset/reinstall a personal wallet to follow an
import tutorial. The NEAR testnet wallet import path still needs confirmation.

## Funding sequence

1. The named NEAR testnet account is already funded; use it for subsequent requests at the
   [official Docs faucet](https://docs.near.org/getting-started/faucet) or [external NEAR faucet](https://near-faucet.io/), respecting their limits. The helper created `showup-dev-14989f.testnet` using the existing public key;
   the external form does not support this wallet's original implicit ID.
2. Request devnet SOL at the [Solana Foundation faucet](https://faucet.solana.com/).
   One 1-SOL RPC airdrop was attempted and rejected because the RPC faucet is closed.
   Do not loop requests, evade rate limits or claim successful funding from a UI
   message alone. Verify the finalized balance after the human completes the form.
3. Request gas ETH on Base Sepolia and Ethereum Sepolia, independently. Base lists
   its [supported faucet options](https://docs.base.org/get-started/get-funds);
   Ethereum lists [network/faucet resources](https://ethereum.org/developers/docs/networks/).
   Some providers require sign-in. Never use a personal funded account to qualify.
4. Request test USDC from [Circle](https://faucet.circle.com/), selecting the exact
   network/address pair. Its web form uses reCAPTCHA. It currently lists Base Sepolia,
   Ethereum Sepolia, Solana Devnet and NEAR Testnet; validate the token contract
   against the deployment manifest before integrating it. Native gas and USDC are
   different assets; receiving USDC does not supply gas.
5. Verify network, recipient, finalized/native balance and token balance. Record
   transaction IDs and source before marking funded. Browser sign-in/CAPTCHA requires
   the owner's approval in the isolated profile; never request a private key on
   a faucet site. Provider requirements and availability can change.

NEAR faucet creation transaction: `EjYigWDCBA7yJcPUyyM8DZ6867SdQnAyFMWZ9e9NLhQt`.
The existing backed-up private key controls the named account; no key was replaced.
The original implicit ID remains unfunded. The web faucet rejects implicit IDs
because its input validator only accepts testnet names or 0x-form addresses.
Use the named account for subsequent NEAR requests/imports.

## Current funding verification

November 3: the owner delegated free faucet requests in the isolated Brave development
profile. The official Docs faucet reported success; NEAR archival and FastNEAR
agreed at finalized block `276103324` (`5zpbP8quGU4FHcnjRPi639gp9qaNGqJkKQEpaHs2rmDn`)
on **14.9999553634875 test NEAR**, exactly 5 more than the prior balance, and **0
test USDC** at the pinned engineering token. Native funding is sufficient for the
prepared experiment. The earlier external 2-NEAR request returned an empty page
without a confirmed arrival.

The owner subsequently approved the prepared Circle CAPTCHA and native experiment.
Circle reported 20 test USDC sent. NEAR archival and FastNEAR agree at finalized
block `276115628` (`DM9kj8ipYydVUgtFK7bXkHafAVZUtYSiZtWVuUZhN8xM`) on
**14.9999553634875 test NEAR and 20 test USDC** at the pinned token, before
experiment execution. Receipt: `/private/tmp/showup-faucet-balances-1793748389086.json`;
UI confirmation: `/private/tmp/showup-circle-funded-approved.jpg`. Faucet funding
loaded no key and enabled no application route. The separately approved native
operator loaded only the original testnet key for its exact plan and budget.
The trial's reservation failed after a prepaid-gas error and authorization expiry.
Approved recovery returned the original 5 test USDC and cancelled the event.
Both sources agreed at finalized block `276118428` on restoration of 20 test USDC,
zero attendee/escrow test USDC and zero owed. No normal funded round trip or
application route qualification is claimed. Child native balances/storage and
recovery keys are retained; no account/key deletion or application-key change occurred.
The later separately approved reuse trial did reach actual escrow funding, then
cancelled and recovered all 5 test USDC. Its driver passed two-source terminal
checks and restored at least the original 20-test-USDC root baseline. See the
current table/receipt for limits; public-testnet normal release and live routing remain unproved.

At 18:25 UTC on November 1, public RPC checks reconfirmed Ethereum Sepolia chain ID
11155111 and Base Sepolia 84532. Native balances were 6999999980865550 wei and
3000000000000000 wei respectively. Circle's test USDC contracts each returned
20000000 atomic units (20 USDC). NEAR finalized account balance was 10 NEAR and
the original public key had been verified with FullAccess permission at 18:10 UTC. Solana finalized
balance was 5000000000 lamports (5 SOL), genesis ID
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

The earlier bridge arrival delay is resolved. The isolated browser's completed
bridge page displays source transaction
`0x231471d8625f217666f2b88c1e966eeb3ced947689a6145d05d05f9064ac622d`
and destination transaction
`0x392b747389325d54f23c7b17d0528273a1c04d26ff16e4fde5e2a93f58f125b7`.
These hashes are UI evidence only; transaction receipts have not been independently
reconciled. At the 18:25 UTC funding check, Ethereum Sepolia's outgoing nonce was
1 and Base Sepolia's was 0; the two later Base tests used nonces 0 and 1.
Rabby and Phantom are installed/imported in the isolated Brave profile according
to the owner. EVM ownership and Base Sepolia self-transfer receipts are now
verified below; Solana/NEAR signing remain untested. Solana test USDC has not
been checked or recorded as funded.

These balances support small initial tests, not a guarantee of all future contract
storage, deployment or provider costs. No mainnet funds or Intents tests are enabled.

## Ownership test preparation

A temporary, dependency-free Rabby test page is prepared in the owner-approved,
ignored `.agents/wallet-tests/` folder. Its server binds only to
`http://127.0.0.1:8765`; no application implementation is included in Git.
The page requires the project EVM address and Base Sepolia chain ID 84532.
It requests only an [ERC-191](https://eips.ethereum.org/EIPS/eip-191) message
signature with an [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361) origin,
single-use nonce and ten-minute expiry. The statement explicitly limits consent
to test-wallet ownership, without funds movement, token approval, delegation or
production login. Connection, unlock and signing prompts remain owner-operated.

Local preflight checks passed: Python/JavaScript syntax, Keccak/public-curve
reference checks, the [ethers published signature vector](https://docs.ethers.org/v5/api/signer/),
modified-message rejection, page delivery, server-file denial, wrong Host/origin
rejection and invalid-signature rejection. This scratch verifier is not audited
production cryptography. At 18:33:09 UTC on November 1, the owner signed the
ownership message in Rabby. Local recovery matched the recorded EVM address;
wrong nonce/domain, modified text, wrong key, expiry and replay were rejected.
The page showed VERIFIED and saved `ownership-result.json` in local scratch.
No transfer or token approval was part of this test. Public funding/preflight
evidence and the signed message remain outside Git.

The owner connected the project account. The page rejected message preparation
because the site was on Ethereum Sepolia; Rabby's custom-network list showed only
Sepolia (11155111). The owner added Base Sepolia, and selecting it for the local
site passed the chain-ID gate (84532) before message preparation and signing.
This verifies EVM signing control only; Solana/NEAR ownership tests and production
authentication remain untested.

The first native self-transfer is prepared for Base Sepolia: 0.000001 test ETH
to the same project address, empty call data, nonce 0 and 21,000 gas. Proposed
gas price 0.01 gwei implies 0.00000021 ETH execution cost plus Base's additional
fees; the owner review ceiling is 0.000001 ETH in total fees, not an on-chain cap
on those additional fees. Public RPC confirmed 0.003 ETH before balance, empty
recipient code and a 21,000-gas estimate. Changing the wallet RPC to
`https://sepolia.base.org` resolved the browser preflight rate-limit failure.

The owner signed the native self-transfer. At 18:46 UTC, Base's public RPC and
PublicNode agreed on successful receipt
[`0xa47a40aa…075c90b6`](https://sepolia.basescan.org/tx/0xa47a40aa12defc2e596cfdfd4be892625188937844b53ce7634f9e05075c90b6)
in block 53184329. Chain, sender, recipient, amount and empty call data matched.
Rabby increased the signed gas limit to 31,500; actual use was 21,000 at 0.01 gwei.
Execution cost 210000000000 wei plus L1 fee 90 wei exactly reconciled the balance
change from 3000000000000000 to 2999789999999910 wei, below the review ceiling.
Inclusion and fee accounting passed; finality remains pending (finalized head
53178974 at that check). Local receipt evidence is in
`.agents/wallet-tests/native-transfer-result.json`; no duplicate send is needed.
The next check transferred 0.01 test USDC (10000 atomic units, six decimals) to the
same project address through Circle's Base Sepolia contract
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Read-only simulation returned true,
with 20 USDC before balance and 40695 estimated gas. The request uses nonce 1,
zero native value, 60000 gas limit and 0.01 gwei; total fee review ceiling remains
0.000001 test ETH. This is a token transfer, not an allowance approval.

The owner signed the USDC transfer. At 18:50 UTC, both RPC providers agreed on
successful receipt
[`0xf6a8170a…9cd8f9ac`](https://sepolia.basescan.org/tx/0xf6a8170a426732d75a37541ada079e8aa6fce8e84387320dd92331709cd8f9ac)
in block 53185675. The exact transfer call and contract event matched the project
address as both sender and token recipient, with 10000 atomic units and zero
native value. Token balance stayed at 20000000 atomic units before/after the block.
Rabby used a 61043 gas limit; actual use was 37447 at 0.01 gwei plus 90 wei L1 fee.
The 374470000090-wei total fee exactly matched the native balance decrease to
2999415529999820 wei and stayed below the review ceiling. Local evidence is in
`.agents/wallet-tests/usdc-transfer-result.json`.

Both receipts remained canonical at the November 1, 18:50 UTC recheck; finality
was still pending then. On November 2 at 09:36 UTC, Base's public RPC and PublicNode
both reported finalized head 53445467, above transaction blocks 53184329 and
53185675. Each successful receipt retained its original canonical block hash.
Both self-transfers are now finalized; no resend was needed. Other-network
transfer tests remain untested.

## Solana ownership preparation

November 2, 09:36 UTC: Solana devnet's genesis ID matched and finalized balance
remained 5000000000 lamports (5 SOL). The next temporary test page uses Phantom's
documented [message-signing interface](https://docs.phantom.com/solana/signing-a-message)
for the dedicated Solana address. The challenge includes the local origin,
address, devnet genesis, single-use nonce and ten-minute expiry, with explicit
ownership-only consent. This off-chain signature does not establish Phantom's
selected transaction network; any later transfer needs separate devnet checks.

The dependency-free local Node verifier uses built-in Ed25519 verification;
the RFC8032 public signature vector and altered-message rejection passed.
Syntax, exact Host/origin checks, source-file denial and malformed-signature
rejection passed. Evidence is in `.agents/wallet-tests/solana-preflight.json`.
The owner unlocked and connected the project account, then signed the message.
At 09:37:58 UTC, local Ed25519 verification passed for the recorded address;
wrong nonce/domain, altered text, wrong address/key, expiry and replay were rejected.
Evidence is in `.agents/wallet-tests/solana-ownership-result.json`. No Solana
transaction has been requested; no project key was read or generated. Next is
devnet transaction preparation with independent network and fee checks.

The proposed native check is 10000 lamports (0.00001 SOL) to the same project
address, with that address also paying the fee. Devnet read-only simulation of
the single System Program transfer succeeded: 5000-lamport fee, 5-SOL starting
balance and 4999995000 lamports afterward. No priority-fee instruction is included.
The owner review ceiling is 10000 lamports total fees. The local page prepares a
fresh devnet blockhash, rechecks its validity before opening Phantom, and permits
one request without automatic retry. The owner confirmed Phantom Devnet selection;
owner review and the actual signed transaction remain pending. An independent
wire-format check matched the one-instruction, same-address transfer and amount;
the server's live simulation also passed.

The first legacy provider request failed with `Reached end of buffer unexpectedly`.
Before another preparation, devnet history showed only the original funding,
balance remained 5 SOL, and the failed blockhash had expired. The local adapter
changed to Wallet Standard with complete unsigned transaction bytes and explicit
`solana:devnet`; account/capability checks and fresh simulation passed.

The owner then signed. At 09:52 UTC on November 2, the official devnet RPC returned
a successful finalized receipt in slot 517815677 for
[`ziZeQ5Dp…nmED9x3z`](https://explorer.solana.com/tx/ziZeQ5Dpu1NWTRD8ioSCpHhu4AFKppq9jVEEFoSCMRNA2zCkQmgWgzaL8XvHHSYWyCzbahPBt97Eg45nmED9x3z?cluster=devnet).
The 10000-lamport System Program transfer had the expected address as sender,
recipient and fee payer. **The fee-limit check failed:** Phantom added two compute
budget instructions (200000 compute units and 375000 micro-lamports per unit).
The 75000-lamport priority fee plus 5000 base fee totaled 80000 lamports
(0.00008 SOL), exceeding the 10000-lamport review ceiling. The finalized balance
of 4999920000 lamports (4.99992 SOL) exactly reconciles that charge.

Evidence: `.agents/wallet-tests/solana-transfer-result.json`, checked against one
official devnet RPC. Execution/finality passed; fee control did not. A successful
simulation of the prepared bytes did not constrain the wallet's signed output.
Resolve wallet transaction modifications and fee enforcement before further
signing. Do not repeat this transfer to obtain another receipt. No application
implementation or production security validation follows from this test.

## Ethereum Sepolia native check

November 2: the owner signed 0.000001 test ETH to the same project address on
chain 11155111, with empty call data and nonce 1. PublicNode returned successful
receipt [`0x311e810d…8b4c01d`](https://sepolia.etherscan.io/tx/0x311e810d265ecb47d8cc8bf0a2456e68546625ec86486ae8b6b74d2848b4c01d).
Actual gas 12000 at 0.01 gwei cost 120000000000 wei (0.00000012 ETH), below the
0.000001-ETH review ceiling. Before/after block balances reconciled exactly:
6999999980865550 to 6999879980865550 wei. Finality is pending; a second provider
timed out, so this receipt currently has one-provider verification.
Local evidence: `.agents/wallet-tests/ethereum-native-result.json`.

## Solana fee-control retest

The next Solana fee retest explicitly sets zero compute-unit price and a 1000-unit
limit. Devnet simulation returned a 5000-lamport fee. The local page requests
signing only, rejects changed transaction bytes or invalid signatures, and checks
the signed message fee before enabling a separate owner-operated broadcast.
Unsigned-signature and changed-message rejection checks passed. The owner signed
and separately broadcast the verified bytes. The retest finalized in slot 517818472:
[`4z45LiBZ…7cVMD27e`](https://explorer.solana.com/tx/4z45LiBZk8X9pnDy8XCJp6z5yKJ4FUYyooF43JDPRWvrWhVDT6XLTkZDJRQ4dsvgsZU8yhrwYzqAoH8K7cVMD27e?cluster=devnet).
The on-chain message exactly matched the prepared bytes, including zero priority
fee. Actual fee was 5000 lamports; balance decreased from 4999920000 to 4999915000
lamports (4.999915 SOL), with the 10000-lamport self-transfer verified. Fee control
and accounting passed. Evidence: `.agents/wallet-tests/solana-fee-retest-result.json`;
one official devnet RPC checked. The earlier over-ceiling result remains recorded.

## NEAR signing preparation

Testnet RPC reconfirmed 10 NEAR and the original FullAccess public key. No NEAR
CLI is installed. An owner-operated, dependency-free Node script is prepared in
`.agents/wallet-tests/near-ownership.mjs` for an off-chain
[NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md) message.
It requires a terminal and explicit typed consent before reading the existing
dedicated NEAR key locally; it never prints secrets, changes keys or constructs
transactions. Public Ed25519 and serialization checks passed without opening the
secret file. The owner approved and ran the script: ownership verified at
10:09:32 UTC on November 2, with changed text, nonce, domain, expiry and replay
rejection. Independent verification of the saved public signature also passed.
Evidence: `.agents/wallet-tests/near-ownership-result.json`. This is temporary
wallet testing, not production authentication implementation.

The final native test is prepared in `.agents/wallet-tests/near-transfer.mjs`:
0.0001 test NEAR to `showup-dev-14989f.testnet` itself, one Transfer action,
no contract call or key change. Current protocol fees estimate 0.0000446365125
NEAR, with a 0.0001-NEAR pre-send review ceiling, not an on-chain fee cap.
The owner must run the script and type the exact transfer confirmation; no
agent-operated signing is authorized. The script rechecks network, original key,
balance, nonce and fees, records the transaction ID before sending once, and
refuses another attempt. Its serializer matches the official near-api-js transfer
test vector. The owner signed and sent the transfer at 10:13 UTC on November 2.
NEAR RPC and FastNear both returned `FINAL` success for
[`7t6mEWan…q4cw1jic`](https://testnet.nearblocks.io/txns/7t6mEWanUvbvrfCtVv2YkNP7yiNbp2wqqpeJq4cw1jic).
Sender, recipient, original key, nonce and single 0.0001-NEAR Transfer action
matched. Summed transaction/receipt fees were 44636512500000000000 yoctoNEAR
(0.0000446365125 NEAR), exactly reconciling the balance from 10 NEAR to
9.9999553634875 NEAR and passing the review ceiling. Public evidence is in
`.agents/wallet-tests/near-transfer-result.json`.

All initial wallet signing steps are finished. Ethereum finality remains the only
read-only follow-up: its successful canonical receipt is in block `0xb7d432`,
while PublicNode's latest checked finalized head is `0xb7d42b`. The additional
dRPC check was rejected; it supplies no corroborating evidence. No resend is
needed. These tests do not verify escrow, cross-chain routes or application behavior.

## Proof-of-work faucet review

Reviewed November 1, 2026 before installation. Rust/Cargo 1.88.0 is available;
`devnet-pow` is not installed. `cargo info` downloaded version 0.1.4 source into
a temporary isolated cache for inspection; no executable was built or run.

[Solana's guide](https://solana.com/developers/cookbook/development/airdrops-and-faucets)
links the [upstream faucet](https://github.com/jarry-xiao/proof-of-work-faucet).
The published 0.1.4 CLI loads a payer keypair before executing commands and calls
`Transaction::new_signed_with_payer` with that payer and a mined signer. The
program transfers the reward to the payer; the transaction fee is charged before
program execution. The reward therefore cannot fund the initial transaction fee.
Source: [CLI](https://github.com/jarry-xiao/proof-of-work-faucet/blob/main/cli/src/main.rs),
[program](https://github.com/jarry-xiao/proof-of-work-faucet/blob/main/programs/proof-of-work-faucet/src/lib.rs).
The published crate was inspected too; upstream default-branch links can change.

At the time of that review the project address had zero finalized lamports. It
now has 5 SOL, so this mining route is unnecessary. The published tool needs
initial devnet gas and authorized local signing before it is useful. The earlier
claim that it required only a public address was incorrect for this version.
No project key was read, no wallet configuration was reused, no global toolchain
was changed, and no mining transaction was attempted. Dependency advisories/build
scripts have not been audited, so this is not installation or security approval.
If ever revisited, use exact pinned reviewed tooling,
explicit devnet/key path, a small reward target and a wall-clock limit.
