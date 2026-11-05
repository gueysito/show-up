import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readV1Snapshot, v1Deployment } from "../../src/server/protocol/v1-escrow";

test("V1 live reads bind both provider responses to the same finalized block and deployed code", async () => {
  const event = { id: randomUUID(), title: "Real terms", capacity: 2 },
    hash = "11111111111111111111111111111111";
  let wrongCode = false,
    disagree = false,
    wrongBlock = false;
  const timestamp = Date.now();
  const transport = (async (origin: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    let result: unknown;
    if (request.method === "status") result = { chain_id: "mainnet" };
    else if (request.method === "block")
      result = {
        header: {
          hash,
          height: 100,
          timestamp_nanosec: (BigInt(timestamp) * 1000000n).toString(),
        },
      };
    else if (request.method === "query") {
      result = {
        block_hash: wrongBlock ? "changed" : hash,
        block_height: 100,
        ...(request.params.request_type === "view_account"
          ? { code_hash: wrongCode ? "changed" : v1Deployment.codeHash }
          : {
              result: [
                ...Buffer.from(
                  JSON.stringify({
                    ...event,
                    capacity: disagree && origin.includes("drpc") ? 3 : 2,
                  }),
                ),
              ],
            }),
      };
    } else throw new Error("Unexpected method");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  }) as typeof fetch;
  assert.equal((await readV1Snapshot(event.id, transport)).event?.capacity, 2);
  wrongCode = true;
  await assert.rejects(readV1Snapshot(event.id, transport), /deployment changed/);
  wrongCode = false;
  disagree = true;
  await assert.rejects(readV1Snapshot(event.id, transport), /sources disagree/);
  disagree = false;
  wrongBlock = true;
  await assert.rejects(readV1Snapshot(event.id, transport), /block mismatch/);
});
