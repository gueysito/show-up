import type { WalletChallenge } from "../../server/wallets/proof";
import { evmVerificationMessage } from "./wallet-apps";

type EvmNetwork = "base" | "ethereum";
type RabbyMethod = "personal_sign" | "eth_sendTransaction";
export type RabbyPrompt = { step: "connect" | "sign"; href: string };

async function initialize(projectId: string, origin: string) {
  const { SignClient } = await import("@walletconnect/sign-client");
  return SignClient.init({
    projectId,
    logger: "silent",
    telemetryEnabled: false,
    metadata: {
      name: "Showup",
      description: "Connect your wallet to Showup",
      url: origin,
      icons: [],
    },
  });
}

let relay: Promise<Awaited<ReturnType<typeof initialize>>> | undefined;

function waitForWallet<T>(result: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function connectRabbySession(
  projectId: string,
  network: EvmNetwork,
  signal: AbortSignal,
  showPrompt: (prompt: RabbyPrompt) => void,
  method: RabbyMethod,
  source?: string,
) {
  const origin = window.location.origin;
  const chain = network === "base" ? "8453" : "1";
  const chainId = `eip155:${chain}`;
  relay ??= initialize(projectId, origin).catch((error: unknown) => {
    relay = undefined;
    throw error;
  });
  const client = await waitForWallet(relay, signal);
  const { uri, approval } = await client.connect({
    optionalNamespaces: { eip155: { chains: [chainId], methods: [method], events: [] } },
  });
  if (!uri?.startsWith("wc:")) throw new Error("WalletConnect did not create a pairing link");
  const disconnect = (topic: string) => {
    void client
      .disconnect({ topic, reason: { code: 6000, message: "Verification ended" } })
      .catch(() => {});
  };
  const approved = approval().then((session) => {
    if (signal.aborted) disconnect(session.topic);
    return session;
  });
  const pairing = new URL("rabby://walletconnect");
  pairing.searchParams.set("uri", uri);
  if (!signal.aborted) showPrompt({ step: "connect", href: pairing.href });
  const session = await waitForWallet(approved, signal);
  const namespaces = Object.values(session.namespaces);
  const accounts = [
    ...new Set(
      namespaces
        .filter((namespace) => namespace.methods.includes(method))
        .flatMap((namespace) => namespace.accounts)
        .filter((account) => account.startsWith(`${chainId}:`)),
    ),
  ];
  const address = accounts[0]?.slice(chainId.length + 1);
  if (
    accounts.length !== 1 ||
    !/^0x[0-9a-f]{40}$/i.test(address) ||
    (source && address.toLowerCase() !== source.toLowerCase())
  ) {
    disconnect(session.topic);
    throw new Error(
      source
        ? "Connect the verified deposit account in Rabby on the selected network."
        : "Rabby did not approve one account on the selected network",
    );
  }
  return {
    address,
    close: () => disconnect(session.topic),
    async request(params: unknown[]) {
      signal.throwIfAborted();
      const showSigningLink = (event: { topic: string; chainId: string }) => {
        if (event.topic === session.topic && event.chainId === chainId)
          showPrompt({ step: "sign", href: "rabby://" });
      };
      client.on("session_request_sent", showSigningLink);
      try {
        return await waitForWallet(
          client.request<string>({
            topic: session.topic,
            chainId,
            request: { method, params },
          }),
          signal,
        );
      } finally {
        client.off("session_request_sent", showSigningLink);
      }
    },
  };
}

export async function connectRabby(
  projectId: string,
  network: EvmNetwork,
  signal: AbortSignal,
  showPrompt: (prompt: RabbyPrompt) => void,
) {
  const session = await connectRabbySession(
    projectId,
    network,
    signal,
    showPrompt,
    "personal_sign",
  );
  return {
    address: session.address,
    close: session.close,
    sign(challenge: WalletChallenge) {
      if (
        challenge.network !== network ||
        challenge.chainId !== (network === "base" ? "8453" : "1") ||
        challenge.origin !== window.location.origin ||
        challenge.address.toLowerCase() !== session.address.toLowerCase() ||
        challenge.expiresAt <= Date.now()
      )
        throw new Error("Wallet challenge no longer matches the selected Rabby account");
      return session.request([evmVerificationMessage(challenge.message), session.address]);
    },
  };
}

export function connectRabbyPayment(
  projectId: string,
  network: EvmNetwork,
  source: string,
  signal: AbortSignal,
  showPrompt: (prompt: RabbyPrompt) => void,
) {
  return connectRabbySession(projectId, network, signal, showPrompt, "eth_sendTransaction", source);
}
