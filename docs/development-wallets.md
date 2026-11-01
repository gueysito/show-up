# Development wallets and faucet setup

Prepared November 1, 2026. Public test addresses only. These accounts are dedicated
to Showup engineering networks; never fund them with real assets. Key generation
is not activation, funding, browser import or a tested signing integration.

## Public addresses

| Network | Public address | Verified state |
| --- | --- | --- |
| NEAR testnet | `14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc` | RPC reported UNKNOWN_ACCOUNT; needs testnet activation/funding |
| Base Sepolia / Ethereum Sepolia | `0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a` | Derived from saved uncompressed public key using Keccak-256; compare with Rabby after import; balances not verified |
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

1. Activate/fund the NEAR testnet implicit account through the
   [NEAR faucet](https://near-faucet.io/). A raw key does not create an on-chain
   account. If the faucet rejects implicit IDs, select a documented creation flow
   using this existing public key; do not generate a replacement key by accident.
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

No test tokens are recorded as received at this checkpoint. Mainnet wallets,
mainnet funding, contracts and NEAR Intents transfers remain outside this setup.
