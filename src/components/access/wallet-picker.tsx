import Image from "next/image";
import type { WalletChallenge } from "../../server/wallets/proof";
import { appNames, type MobileWallet } from "./wallet-apps";
import base from "./wallet-icons/base.svg";
import ethereum from "./wallet-icons/ethereum.svg";
import meteor from "./wallet-icons/meteor.svg";
import near from "./wallet-icons/near.svg";
import nearMobile from "./wallet-icons/near-mobile.svg";
import phantom from "./wallet-icons/phantom.svg";
import rabby from "./wallet-icons/rabby.svg";
import solana from "./wallet-icons/solana.svg";

type Network = WalletChallenge["network"];
export type WalletApp = MobileWallet | "near-mobile" | "meteor";
export const networkNames = { near: "NEAR", solana: "Solana", base: "Base", ethereum: "Ethereum" };
const networkIcons = { near, solana, base, ethereum };
const appIcons = { "near-mobile": nearMobile, meteor, phantom, rabby };
const apps: Record<Network, readonly WalletApp[]> = {
  near: ["near-mobile", "meteor"],
  solana: ["phantom"],
  base: ["rabby"],
  ethereum: ["rabby"],
};

export function WalletPicker({
  network,
  selectedApp,
  disabled,
  onNetwork,
  onApp,
}: {
  network: Network;
  selectedApp: WalletApp | null;
  disabled: boolean;
  onNetwork(network: Network): void;
  onApp(app: WalletApp): void;
}) {
  return (
    <div className="wallet-picker">
      <fieldset className="near-wallet-apps" disabled={disabled}>
        <legend>Wallet network</legend>
        {(Object.keys(networkNames) as Network[]).map((item) => (
          <button
            key={item}
            type="button"
            className="secondary-button"
            aria-pressed={network === item}
            onClick={() => onNetwork(item)}
          >
            <Image src={networkIcons[item]} alt="" width={24} height={24} unoptimized />
            {networkNames[item]}
          </button>
        ))}
      </fieldset>
      <fieldset className="near-wallet-apps" disabled={disabled}>
        <legend>{`${networkNames[network]} wallet app`}</legend>
        {apps[network].map((app) => (
          <button
            key={app}
            type="button"
            className="secondary-button"
            aria-pressed={selectedApp === app}
            onClick={() => onApp(app)}
          >
            <Image src={appIcons[app]} alt="" width={24} height={24} unoptimized />
            {appNames[app]}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
