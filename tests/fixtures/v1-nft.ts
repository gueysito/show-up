import { Wallet, Interface } from "ethers";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { v1NftTerms } from "../../src/server/protocol/v1-nft";

export function v1NftFixture() {
  const signer = Wallet.createRandom(),
    recipient = Wallet.createRandom(),
    contributor = "0x1111111111111111111111111111111111111111",
    draft = {
      network: "ethereum" as const,
      collection: "0x42dc0cecefbaf8e81d631a75fa212510c347f66b",
      assetId: "2829",
      contributorReturnAddress: contributor,
    },
    nft = v1NftTerms(draft),
    custody = signer.address.toLowerCase(),
    live = {
      ...nft,
      custody,
      public_key:
        "secp256k1:" + encodeBase58(Buffer.from(signer.signingKey.publicKey.slice(4), "hex")),
      held: false,
      request: null as unknown,
    },
    envelope = { nonce: "0", gas_limit: "100000", max_fee: "10000000", priority_fee: "1000000" },
    block = {
      number: "0x64",
      hash: "0x" + "ab".repeat(32),
      timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
      transactions: [],
    },
    abi = new Interface([
      "function ownerOf(uint256) view returns(address)",
      "function supportsInterface(bytes4) view returns(bool)",
    ]);
  let owner = contributor,
    nonce = "0x0",
    pending = "0x0",
    chain = "0x1",
    price = "0x989680",
    balance = "0x38d7ea4c68000",
    simulation = true;
  const transport: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)),
      method = input.method;
    let result: unknown;
    if (method === "eth_chainId") result = chain;
    else if (method === "eth_getBlockByNumber") result = block;
    else if (method === "eth_getCode") result = input.params[0] === custody ? "0x" : "0x6001";
    else if (method === "eth_getTransactionCount")
      result = input.params[1] === "pending" ? pending : nonce;
    else if (method === "eth_gasPrice") result = price;
    else if (method === "eth_getBalance") result = balance;
    else if (method === "eth_estimateGas") {
      if (!simulation)
        return Response.json({
          jsonrpc: "2.0",
          id: input.id,
          error: { code: -32000, message: "reverted" },
        });
      result = "0x10ac8";
    } else if (method === "eth_call")
      result = input.params[0].data.startsWith("0x6352211e")
        ? abi.encodeFunctionResult("ownerOf", [owner])
        : abi.encodeFunctionResult("supportsInterface", [true]);
    else throw new Error("Unexpected isolated NFT RPC method: " + method);
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  return {
    signer,
    recipient,
    contributor,
    draft,
    nft,
    custody,
    live,
    envelope,
    block,
    transport,
    setOwner: (value: string) => {
      owner = value;
    },
    setNonce: (value: string) => {
      nonce = value;
      pending = value;
    },
    setPending: (value: string) => {
      pending = value;
    },
    setPrice: (value: string) => {
      price = value;
    },
    setBalance: (value: string) => {
      balance = value;
    },
    setChain: (value: string) => {
      chain = value;
    },
    setSimulation: (value: boolean) => {
      simulation = value;
    },
  };
}
