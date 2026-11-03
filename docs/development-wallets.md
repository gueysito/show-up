# Development wallets and faucet setup

Updated November 3, 2026 after the delegated NEAR faucet top-up. Public test addresses only. These accounts are dedicated
to Showup engineering networks; never fund them with real assets. Key generation
is not activation, funding, browser import or a tested signing integration.

## Public addresses

| Network | Public address | Verified state |
| --- | --- | --- |
| NEAR testnet | `showup-dev-14989f.testnet` | Prior ownership/self-transfer evidence retained; finalized balance 14.9999553634875 test NEAR after the November 3 faucet top-up. No operator key was accessed for funding. |
| Base Sepolia / Ethereum Sepolia | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | Ethereum Sepolia 0.00699987998086555 ETH after native self-transfer, finality pending; Base Sepolia 0.00299941552999982 ETH after finalized native/USDC tests. Last checked test USDC balance: 20 on each chain. |
| Solana devnet | `BTXsA7ov3DCLd4yNyK1JpUokk1byw8mSgpGQ6FdGKjKd` | Ownership and native self-transfer verified; fee-control retest finalized; balance 4.999915 SOL |

The same EVM address works on both selected test networks; balances are separate.
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
sync disabled. Import only project test keys. Keep personal browser data, wallet
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
   transaction IDs and source before marking funded. Browser sign-in/CAPTCHA is
   performed by the owner in the isolated profile; never request a private key on
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
without a confirmed arrival. Circle's NEAR/20-test-USDC form is prepared in the same
profile; it requires reCAPTCHA and awaits action-time confirmation. No private key
was loaded, agent-signed public transaction created or application funding route enabled.

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
