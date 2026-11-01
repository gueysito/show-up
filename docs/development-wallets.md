# Development wallets and faucet setup

Prepared November 1, 2026. Public test addresses only. These accounts are dedicated
to Showup engineering networks; never fund them with real assets. Key generation
is not activation, funding, browser import or a tested signing integration.

## Public addresses

| Network | Public address | Verified state |
| --- | --- | --- |
| NEAR testnet | `showup-dev-14989f.testnet` | Created with the original public key; finalized balance 10 test NEAR and matching FullAccess key verified |
| Base Sepolia / Ethereum Sepolia | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | Derived from saved uncompressed public key using Keccak-256; compare with Rabby after import; Ethereum Sepolia RPC balance 0.01 ETH; Base Sepolia RPC balance zero |
| Solana devnet | `BTXsA7ov3DCLd4yNyK1JpUokk1byw8mSgpGQ6FdGKjKd` | Finalized RPC balance zero; RPC faucet returned code 410, directing to web faucet |

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

Ethereum Sepolia has 0.01 ETH, verified by RPC; Base Sepolia remains unfunded.
A bridge deposit is proposed, not executed. Use the testnet route linked by
[Base bridge documentation](https://docs.base.org/base-chain/network-information/ecosystem-bridges),
keeping some Sepolia ETH for gas. Never select mainnet.

For Solana, [SolFaucet](https://solfaucet.com/) presents address/amount fields without
GitHub login, but uses the public RPC faucet and may hit the same closed-service
error. [Solana’s official alternatives](https://solana.com/developers/cookbook/development/airdrops-and-faucets)
also list DevnetFaucet.org with a separate rate limit; its current form also requires GitHub. The official guide lists a proof-of-work
faucet as a no-GitHub alternative, requiring a separately reviewed installation. No SOL receipt is confirmed. Mainnet wallets,
mainnet funding, contracts and NEAR Intents transfers remain outside this setup.

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

The project Solana address still has zero finalized lamports. This route needs
initial devnet gas and authorized local signing before it is useful. The earlier
claim that it required only a public address was incorrect for this version.
No project key was read, no wallet configuration was reused, no global toolchain
was changed, and no mining transaction was attempted. Dependency advisories/build
scripts have not been audited, so this is not installation or security approval.
Revisit only after seed devnet funds arrive; use exact pinned reviewed tooling,
explicit devnet/key path, a small reward target and a wall-clock limit.
