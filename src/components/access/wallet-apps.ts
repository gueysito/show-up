import type { WalletChallenge } from "../../server/wallets/proof";

export type MobileWallet = "phantom" | "rabby" | "metamask";
export type EthereumApp = Exclude<MobileWallet, "phantom">;
export type EthereumProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  providers?: EthereumProvider[];
};

export function injectedEthereumApp(app: EthereumApp) {
  const { ethereum, rabby } = window as Window & {
    ethereum?: EthereumProvider;
    rabby?: EthereumProvider;
  };
  return [rabby, ...(ethereum?.providers ?? []), ethereum].find(
    (provider) =>
      typeof provider?.request === "function" &&
      (app === "rabby" ? provider.isRabby : provider.isMetaMask && !provider.isRabby),
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
  if (app === "phantom")
    return `https://phantom.com/ul/browse/${encodeURIComponent(page.href)}?ref=${encodeURIComponent(page.origin)}`;
  if (app === "metamask")
    return `https://link.metamask.io/dapp/${page.host}${page.pathname}${page.search}`;
  const rabby = new URL("https://go.rabby.io/mobile/");
  rabby.searchParams.set("_cmd", "open-dapp");
  rabby.searchParams.set("dapp", page.href);
  return rabby.href;
}
