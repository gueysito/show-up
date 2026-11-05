import { Interface, toQuantity } from "ethers";
import { ReadOnlyRpc, unsigned } from "./rpc";
import { networkIdentity } from "./manifest";
import { AppFailure } from "../http/security";
import type { V1Route } from "./v1-routing";

const token = new Interface([
  "function transfer(address to,uint256 amount) returns(bool)",
  "function balanceOf(address account) view returns(uint256)",
]);
export async function prepareV1EvmPayment(
  route: V1Route,
  source: string,
  transport?: typeof fetch,
) {
  if (route.network !== "base" && route.network !== "ethereum")
    throw new Error("Expected an EVM USDC route");
  const network = networkIdentity(route.network),
    asset = network.assets.find((asset) => asset.id === "usdc")!;
  const data = token.encodeFunctionData("transfer", [route.depositAddress, BigInt(route.input)]);
  const tx = { from: source, to: asset.contract, value: "0x0", data };
  const endpoints =
    route.network === "base"
      ? ["base-public", "base-publicnode"]
      : ["ethereum-drpc", "ethereum-publicnode"];
  const facts = await Promise.all(
    endpoints.map(async (endpoint) => {
      const rpc = new ReadOnlyRpc(endpoint, transport);
      const [chain, native, balance, price, nonce, pending] = await Promise.all([
        rpc.read("eth_chainId", []),
        rpc.read("eth_getBalance", [source, "latest"]),
        rpc.read("eth_call", [
          { to: asset.contract, data: token.encodeFunctionData("balanceOf", [source]) },
          "latest",
        ]),
        rpc.read("eth_gasPrice", []),
        rpc.read("eth_getTransactionCount", [source, "latest"]),
        rpc.read("eth_getTransactionCount", [source, "pending"]),
      ]);
      if (unsigned(chain).toString() !== network.chainId) throw new Error("Source chain changed");
      if (
        unsigned(token.decodeFunctionResult("balanceOf", String(balance))[0], 256) <
        BigInt(route.input)
      )
        throw new AppFailure(422, "Your source wallet needs the quoted USDC amount.");
      if (unsigned(nonce, 64) !== unsigned(pending, 64))
        throw new AppFailure(
          409,
          "Your source wallet has a pending transaction. Wait before preparing this payment.",
        );
      try {
        const result = await rpc.read("eth_call", [tx, "latest"]);
        if (token.decodeFunctionResult("transfer", String(result))[0] !== true)
          throw new Error("Transfer returned false");
      } catch {
        throw new AppFailure(
          422,
          "The source USDC transfer could not be checked. No payment was submitted.",
        );
      }
      return {
        native: unsigned(native, 256),
        price: unsigned(price, 128),
        nonce: unsigned(nonce, 64),
      };
    }),
  );
  if (facts[0].nonce !== facts[1].nonce)
    throw new AppFailure(409, "Source nonce providers disagree. Check again shortly.");
  const gas = 100000n,
    price = facts.reduce((max, value) => (value.price > max ? value.price : max), 0n),
    reserve = route.network === "base" ? 5000000000000n : 0n;
  const maximum = gas * price + reserve,
    cap = route.network === "base" ? 20000000000000n : 80000000000000n;
  if (price === 0n || maximum > cap || facts.some((value) => value.native < maximum))
    throw new AppFailure(
      422,
      "Source gas is above this small-transfer limit or your native balance is insufficient. Check again when fees are lower.",
    );
  return {
    network: route.network,
    transaction: {
      ...tx,
      chainId: toQuantity(BigInt(network.chainId)),
      gas: toQuantity(gas),
      gasPrice: toQuantity(price),
      nonce: toQuantity(facts[0].nonce),
    },
    maximumGasWei: maximum.toString(),
    inputAtomic: route.input,
    expiresAt: route.expiresAt,
  };
}
