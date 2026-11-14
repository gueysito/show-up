import type { WalletChallenge } from "../../server/wallets/proof";

export type MobileWallet = "phantom" | "rabby";
export type EthereumApp = Exclude<MobileWallet, "phantom">;
export const appNames = {
  "near-mobile": "NEAR Mobile",
  meteor: "Meteor Wallet",
  phantom: "Phantom",
  rabby: "Rabby",
};
export type EthereumProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  isRabby?: boolean;
  providers?: EthereumProvider[];
};

export function announcedEthereumApp(event: Event) {
  const { info, provider } =
    (event as CustomEvent<{ info?: { rdns?: string }; provider?: EthereumProvider }>).detail ?? {};
  const app = info?.rdns === "io.rabby" ? "rabby" : null;
  return app && typeof provider?.request === "function" ? ({ app, provider } as const) : null;
}

export function evmVerificationMessage(message: string) {
  return (
    "0x" +
    Array.from(new TextEncoder().encode(message), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

export function injectedRabby() {
  const { ethereum, rabby } = window as Window & {
    ethereum?: EthereumProvider;
    rabby?: EthereumProvider;
  };
  return [rabby, ...(ethereum?.providers ?? []), ethereum].find(
    (provider) => typeof provider?.request === "function" && provider.isRabby,
  );
}

export function mobileWalletUrl(
  app: MobileWallet,
  origin: string,
  network: WalletChallenge["network"],
  eventId?: string,
) {
  const page = new URL("/account/wallets", origin);
  page.searchParams.set("network", network);
  page.searchParams.set("app", app);
  if (eventId) page.searchParams.set("event", eventId);
  return mobileWalletPageUrl(app, page);
}

export function mobileWalletPageUrl(app: MobileWallet, page: URL) {
  if (app === "phantom")
    return `https://phantom.com/ul/browse/${encodeURIComponent(page.href)}?ref=${encodeURIComponent(page.origin)}`;
  const rabby = new URL("https://go.rabby.io/mobile/");
  rabby.searchParams.set("_cmd", "open-dapp");
  rabby.searchParams.set("dapp", page.href);
  return rabby.href;
}
