import assert from "node:assert/strict";
import test from "node:test";
import { v1Deployment } from "../../src/server/protocol/v1-escrow";
import {
  readV1Reserves,
  v1ControllerSigningFloor,
  v1RouteAccountFloor,
} from "../../src/server/protocol/v1-reserves";

test("reserve reads distinguish escrow storage from the controller's signing balance", async () => {
  const hash = "11111111111111111111111111111111";
  const timestamp = Date.now();
  let disagreement = false;
  const transport = (async (origin: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    let result: unknown;
    if (request.method === "status") result = { chain_id: "mainnet" };
    else if (request.method === "block")
      result = {
        header: { hash, height: 100, timestamp_nanosec: (BigInt(timestamp) * 1000000n).toString() },
      };
    else {
      assert.equal(request.method, "query");
      assert.equal(request.params.block_id, hash);
      const escrow = request.params.account_id === v1Deployment.account;
      result = {
        block_hash: hash,
        block_height: 100,
        amount: escrow
          ? disagreement && origin.includes("drpc")
            ? "3410000000000000000000000"
            : "3404000000000000000000000"
          : "200641000000000000000000",
        storage_usage: escrow ? 339382 : 182,
      };
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  }) as typeof fetch;
  const reserve = await readV1Reserves(transport);
  assert.equal(reserve.escrow, 10_180_000_000_000_000_000_000n);
  assert(reserve.escrow < v1RouteAccountFloor);
  assert.equal(reserve.controller, 200_641_000_000_000_000_000_000n);
  assert(reserve.controller > v1ControllerSigningFloor);
  disagreement = true;
  await assert.rejects(readV1Reserves(transport), /reserve sources disagree/);
});
