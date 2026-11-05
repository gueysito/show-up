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
      const [chain, native, balance, price] = await Promise.all([
        rpc.read("eth_chainId", []),
        rpc.read("eth_getBalance", [source, "latest"]),
        rpc.read("eth_call", [
          { to: asset.contract, data: token.encodeFunctionData("balanceOf", [source]) },
          "latest",
        ]),
        rpc.read("eth_gasPrice", []),
      ]);
      if (unsigned(chain).toString() !== network.chainId) throw new Error("Source chain changed");
      if (unsigned(balance, 256) < BigInt(route.input))
        throw new AppFailure(422, "Your source wallet needs the quoted USDC amount.");
      return { native: unsigned(native, 256), price: unsigned(price, 128) };
    }),
  );
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
    },
    maximumGasWei: maximum.toString(),
    inputAtomic: route.input,
    expiresAt: route.expiresAt,
  };
}
