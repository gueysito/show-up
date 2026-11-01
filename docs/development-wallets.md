# Development wallets and faucet setup

Updated November 1, 2026, 18:25 UTC. Public test addresses only. These accounts are dedicated
to Showup engineering networks; never fund them with real assets. Key generation
is not activation, funding, browser import or a tested signing integration.

## Public addresses

| Network | Public address | Verified state |
| --- | --- | --- |
| NEAR testnet | `showup-dev-14989f.testnet` | Created with the original public key; finalized balance 10 test NEAR and matching FullAccess key verified |
| Base Sepolia / Ethereum Sepolia | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | Derived from saved uncompressed public key using Keccak-256; Ethereum Sepolia ~0.007 ETH + 20 test USDC; Base Sepolia 0.003 ETH + 20 test USDC; chain IDs verified |
| Solana devnet | `BTXsA7ov3DCLd4yNyK1JpUokk1byw8mSgpGQ6FdGKjKd` | Finalized RPC balance 5 SOL; devnet genesis ID verified |

The same EVM address works on both selected test networks; balances are separate.
EVM derivation used public data only, with empty-input and abc Keccak-256 reference
vectors checked. Wallet-import comparison remains an independent verification step.

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
   [NEAR faucet](https://near-faucet.io/). The helper created `showup-dev-14989f.testnet` using the existing public key;
   the web form does not support this wallet's original implicit ID.
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
reconciled. Ethereum Sepolia's outgoing nonce is 1; Base Sepolia's is 0.
Rabby and Phantom are installed/imported in the isolated Brave profile according
to the owner. Wallet signature ownership and outgoing transfers have not been
verified. Solana test USDC has not been checked or recorded as funded.

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
production cryptography. Actual project-wallet verification and its nonce/domain,
modified-text, wrong-key, expiry and replay checks remain pending. No new transfer
or token approval has been requested. Public funding/preflight evidence is saved
locally; signatures will also remain outside Git.

The owner connected the project account. The page rejected message preparation
because the site was on Ethereum Sepolia; Rabby's custom-network list showed only
Sepolia (11155111). Base Sepolia (84532) still needs to be added/selected in the
isolated wallet. No ownership-signing prompt has been opened.

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
