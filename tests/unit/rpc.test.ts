import assert from "node:assert/strict";
import test from "node:test";
import { canonicalHash, canonicalJson } from "../../src/server/protocol/canonical";
import { parseRpcJson, ReadOnlyRpc, unsigned } from "../../src/server/protocol/rpc";

test("attestations preserve exact integers and canonical nested context without executable values", () => {
  assert.equal(
    canonicalJson({ z: [{ b: 2, a: "☀" }], a: null }),
    '{"a":null,"z":[{"a":"☀","b":2}]}',
  );
  assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
  assert.equal(canonicalJson({ "\u{10000}": 1, "\ue000": 2 }), '{"\ue000":2,"\u{10000}":1}');
  assert.throws(() => canonicalJson({ "\ud800": 1 }), /Invalid attestation key/);
  for (const value of [undefined, NaN, Infinity, 0.5, 2 ** 54, 1n, new Date(), "\ud800", () => 1])
    assert.throws(() => canonicalHash(value));
  assert.throws(() => canonicalHash(Array(257).fill(0)));
  assert.throws(() => canonicalHash("x".repeat(32769)));
  const decoded = parseRpcJson(
    '{"small":123,"large":9007199254740993,"max":18446744073709551615}',
  ) as Record<string, unknown>;
  assert.equal(decoded.small, 123);
  assert.equal(decoded.large, 9007199254740993n);
  assert.equal(unsigned(decoded.max, 64), 18446744073709551615n);
  for (const value of [-1, 0.5, "01", "0x00", "0X1", "1e20", Infinity, 2 ** 54])
    assert.throws(() => unsigned(value));
  assert.throws(() => unsigned("18446744073709551616", 64));
  assert.throws(() => unsigned("1", 1e9));
  assert.throws(() => parseRpcJson('{"n":1e99}'));
});

test("RPC endpoint and method allowlists block writes, arbitrary origins and raw state reads before HTTP", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    throw new Error("not expected");
  };
  assert.throws(() => new ReadOnlyRpc("https://127.0.0.1", transport), /Unregistered/);
  for (const [id, method, params] of [
    ["base-public", "eth_sendRawTransaction", []],
    ["near-public", "broadcast_tx_commit", []],
    ["solana-public", "sendTransaction", []],
    ["near-public", "query", { request_type: "view_state" }],
  ] as const)
    await assert.rejects(
      new ReadOnlyRpc(id, transport).read(method, params),
      /read-only|Unapproved/,
    );
  assert.equal(calls, 0);
  let serialized = false;
  const nonData = {
    toJSON() {
      serialized = true;
      return "not-public-rpc-data";
    },
  };
  await assert.rejects(
    new ReadOnlyRpc("base-public", transport).read("eth_chainId", [nonData]),
    /Unsupported/,
  );
  assert.equal(
    serialized,
    false,
    "Request construction must not invoke a caller's serialization hook",
  );
  assert.equal(calls, 0);
});

test("RPC correlates response IDs, preserves pending null, rejects errors/bounds and uses bounded transient retries", async () => {
  let calls = 0;
  const rpc = new ReadOnlyRpc("base-public", async (url, options) => {
    calls++;
    assert.equal(String(url), "https://mainnet.base.org");
    assert.equal(options?.redirect, "error");
    const request = JSON.parse(String(options?.body));
    if (calls === 1) throw new TypeError("temporary");
    if (calls === 2) return new Response(null, { status: 429 });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: null });
  });
  assert.equal(await rpc.read("eth_getTransactionReceipt", ["0x" + "a".repeat(64)]), null);
  assert.equal(calls, 3);
  let rateResponses = 0;
  const temporarilyLimited = new ReadOnlyRpc("base-public", async (_url, options) => {
    const { id } = JSON.parse(String(options?.body));
    return Response.json(
      ++rateResponses === 1
        ? { jsonrpc: "2.0", id, error: { code: -32005 } }
        : { jsonrpc: "2.0", id, result: "0x1" },
    );
  });
  assert.equal(await temporarilyLimited.read("eth_chainId", []), "0x1");
  assert.equal(rateResponses, 2);
  for (const response of [
    { jsonrpc: "2.0", id: 999, result: "0x1" },
    { jsonrpc: "2.0", id: 1, error: { message: "internal" } },
    { jsonrpc: "1.0", id: 1, result: "0x1" },
  ])
    await assert.rejects(
      new ReadOnlyRpc("base-public", async () => Response.json(response)).read("eth_chainId", []),
      /Invalid/,
    );
  await assert.rejects(
    new ReadOnlyRpc("base-public", async () => new Response("x".repeat(2097153))).read(
      "eth_chainId",
      [],
    ),
    /size limit/,
  );
  const signal = AbortSignal.abort();
  await assert.rejects(
    new ReadOnlyRpc("base-public", async () => {
      throw new Error("not expected");
    }).read("eth_chainId", [], signal),
  );
});
