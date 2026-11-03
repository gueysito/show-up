import assert from "node:assert/strict";
import test from "node:test";
import { settlementFixture } from "../fixtures/settlement";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import {
  compareSettlementState,
  compareEngineeringSettlementState,
  validateSettlementState,
} from "../../src/server/protocol/settlement-state";

test("contract-owned state distinguishes actual funded seats, expiring reservations and unsettled returns", () => {
  const f = settlementFixture(),
    funded = validateSettlementState(f.context, f.views, f.block);
  assert.equal(funded.registration?.booked, true);
  assert.equal(funded.fundingAllowed, false);
  assert.equal(funded.sourceQualified, false);
  assert.equal(funded.capacity, 1);
  const views = structuredClone(f.views),
    event = views.event as Record<string, unknown>;
  const entry = views.registration as Record<string, unknown>;
  event.funded = [];
  event.reserved = [f.context.authorization.registration];
  entry.state = "reserved";
  views.accounting = { received: "0", delivered: "0", owed: "0", unallocated: "0" };
  views.tokenBalance = "0";
  const reserved = validateSettlementState(f.context, views, f.block);
  assert.equal(reserved.registration?.booked, false);
  assert.equal(reserved.registration?.reservedUntil, f.context.authorization.reservation_ms);
  assert.equal(
    validateSettlementState(f.context, views, {
      ...f.block,
      timestampMs: Number(f.context.authorization.reservation_ms),
    }).registration?.reservedUntil,
    null,
  );
  event.reserved = [];
  entry.state = "return_only";
  views.returned = {
    destination: f.context.authorization.refund,
    total: "2000000",
    paid: "0",
    attempts: 0,
    pending: null,
  };
  views.accounting = { received: "2000000", delivered: "0", owed: "2000000", unallocated: "0" };
  views.tokenBalance = "2000000";
  const returned = validateSettlementState(f.context, views, f.block);
  assert.equal(returned.registration?.booked, false);
  assert.equal(returned.returned?.remaining, "2000000");
  event.funded = [f.context.authorization.registration];
  entry.state = "funded";
  views.accounting = {
    received: "7000000",
    delivered: "0",
    owed: "2000000",
    unallocated: "5000000",
  };
  views.tokenBalance = "7000000";
  assert.equal(validateSettlementState(f.context, views, f.block).registration?.booked, true);
});

test("settlement validation rejects changed authorization/rules, impossible capacity and unsupported state", () => {
  const f = settlementFixture();
  const changes: ((views: typeof f.views) => void)[] = [
    (v) => {
      (v.registration as Record<string, unknown>).authorization = {
        ...f.context.authorization,
        payout: { network: "near", asset: f.context.token, address: "attacker.near" },
      };
    },
    (v) => {
      ((v.event as Record<string, unknown>).terms as Record<string, unknown>).principal = "4000000";
    },
    (v) => {
      (v.event as Record<string, unknown>).funded = [
        f.context.authorization.registration,
        "a".repeat(64),
      ];
    },
    (v) => {
      (v.event as Record<string, unknown>).funded = [
        f.context.authorization.registration,
        f.context.authorization.registration,
      ];
    },
    (v) => {
      (v.event as Record<string, unknown>).reserved = [f.context.authorization.registration];
    },
    (v) => {
      (v.registration as Record<string, unknown>).state = "provider_success";
    },
    (v) => {
      v.registration = null;
    },
    (v) => {
      (v.event as Record<string, unknown>).attendance = 2;
    },
    (v) => {
      (v.event as Record<string, unknown>).status = "cancelled";
    },
    (v) => {
      (v.event as Record<string, unknown>).extra = "client hash is not evidence";
    },
    (v) => {
      v.tokenBalance = "4999999";
    },
    (v) => {
      (v.accounting as Record<string, unknown>).owed = "1";
    },
    (v) => {
      (v.accounting as Record<string, unknown>).received = "05000000";
    },
    (v) => {
      v.accounting = { received: "0", delivered: "0", owed: "0", unallocated: "0" };
      v.tokenBalance = "0";
    },
    (v) => {
      (v.event as Record<string, unknown>).ledger_version = 0;
    },
    (v) => {
      v.principal = {
        destination: f.context.authorization.payout,
        total: "5000000",
        paid: "0",
        attempts: 0,
        pending: null,
      };
    },
    (v) => {
      v.returned = {
        destination: f.context.authorization.refund,
        total: "1",
        paid: "0",
        attempts: 0,
        pending: null,
      };
    },
  ];
  for (const change of changes) {
    const views = structuredClone(f.views);
    change(views);
    assert.throws(() => validateSettlementState(f.context, views, f.block));
  }
  const extra = { ...f.context.authorization, extra: true };
  assert.throws(() =>
    validateSettlementState({ ...f.context, authorization: extra }, f.views, f.block),
  );
  const malformed = structuredClone(f.views);
  ((malformed.event as Record<string, unknown>).terms as Record<string, unknown>).capacity = 0;
  assert.throws(() => validateSettlementState(f.context, malformed, f.block));
});

test("released principal and failed or pending transfers stay recoverable until contract-confirmed payment", () => {
  const f = settlementFixture(),
    event = f.views.event as Record<string, unknown>,
    entry = f.views.registration as Record<string, unknown>;
  event.funded = [];
  entry.state = "released";
  const liability = {
    destination: structuredClone(f.context.authorization.payout) as {
      network: string;
      asset: string;
      address: string;
    },
    total: "5000000",
    paid: "0",
    attempts: 1,
    pending: { number: 1, amount: "5000000" } as { number: number; amount: string } | null,
  };
  f.views.principal = liability;
  f.views.accounting = { received: "5000000", delivered: "0", owed: "5000000", unallocated: "0" };
  assert.equal(
    validateSettlementState(f.context, f.views, f.block).principal?.remaining,
    "5000000",
  );
  liability.pending = null;
  assert.equal(
    validateSettlementState(f.context, f.views, f.block).principal?.remaining,
    "5000000",
  );
  liability.paid = "5000000";
  f.views.accounting = { received: "5000000", delivered: "5000000", owed: "0", unallocated: "0" };
  f.views.tokenBalance = "0";
  assert.equal(validateSettlementState(f.context, f.views, f.block).principal?.remaining, "0");
  liability.destination = { ...liability.destination, address: "attacker.near" };
  assert.throws(() => validateSettlementState(f.context, f.views, f.block));
  liability.destination = structuredClone(
    f.context.authorization.payout,
  ) as typeof liability.destination;
  liability.pending = { number: 1, amount: "1" };
  assert.throws(() => validateSettlementState(f.context, f.views, f.block));
});

test("fixed settlement sources pin code, every view and token conservation to the same finalized block", async () => {
  const now = Date.now();
  let f = settlementFixture(now, "mainnet"),
    expectedChain = "mainnet"; // Mock transport only.
  let mode = "valid",
    calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    const second = new URL(String(url)).hostname.includes("fastnear"),
      input = JSON.parse(String(options?.body));
    assert.equal(new URL(String(url)).protocol, "https:");
    let result: unknown;
    if (input.method === "status")
      result = { chain_id: mode === "wrong-chain" ? "testnet" : expectedChain };
    else if (input.method === "block")
      result = {
        header: {
          height: Number(f.block.height),
          hash: f.block.hash,
          timestamp_nanosec: (BigInt(f.block.timestampMs) * 1_000_000n).toString(),
        },
      };
    else {
      assert.equal(input.method, "query");
      assert.equal(input.params.block_id, f.block.hash);
      const hash =
        mode === "wrong-block" && second ? encodeBase58(Buffer.alloc(32, 8)) : f.block.hash;
      if (input.params.request_type === "view_account") {
        const code =
          input.params.account_id === f.context.deployment
            ? f.context.escrowCodeHash
            : f.context.tokenCodeHash;
        result = {
          code_hash: mode === "changed-code" && second ? encodeBase58(Buffer.alloc(32, 9)) : code,
          block_hash: hash,
          block_height: 100,
        };
      } else {
        assert.equal(input.params.request_type, "call_function");
        const args = JSON.parse(Buffer.from(input.params.args_base64, "base64").toString());
        const views = structuredClone(f.views);
        if (mode === "disagree" && second)
          (views.event as Record<string, unknown>).ledger_version = 2;
        if (mode === "underfunded") views.tokenBalance = "0";
        let value: unknown;
        switch (input.params.method_name) {
          case "get_event":
            assert.equal(args.event, f.context.event);
            value = views.event;
            break;
          case "get_registration":
            assert.equal(args.registration, f.context.authorization.registration);
            value = views.registration;
            break;
          case "get_liability":
            value = args.id.endsWith(":principal") ? views.principal : views.returned;
            break;
          case "accounting":
            assert.deepEqual(args, {});
            value = views.accounting;
            break;
          case "ft_balance_of":
            assert.equal(input.params.account_id, f.context.token);
            assert.equal(args.account_id, f.context.deployment);
            value = views.tokenBalance;
            break;
          default:
            assert.fail("Unapproved method");
        }
        let encoded = JSON.stringify(value);
        if (mode === "large-version" && input.params.method_name === "get_event")
          encoded = encoded.replace('"ledger_version":1', '"ledger_version":18446744073709551615');
        result = {
          block_hash: hash,
          block_height: 100,
          result: mode === "bad-bytes" ? [256] : [...Buffer.from(encoded)],
        };
      }
    }
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  const state = await compareSettlementState(f.context, transport, now);
  assert.equal(state.registration?.booked, true);
  assert.equal(state.fundingAllowed, false);
  assert.equal(state.sourceQualified, false);
  assert.equal(
    state.stateHash,
    canonicalHash(validateSettlementState(f.context, f.views, f.block)),
  );
  assert.deepEqual(state.sourceIds, ["near-public", "near-fastnear"]);
  for (const variant of [
    "wrong-chain",
    "changed-code",
    "wrong-block",
    "disagree",
    "underfunded",
    "bad-bytes",
  ]) {
    mode = variant;
    await assert.rejects(() => compareSettlementState(f.context, transport, now), variant);
  }
  mode = "large-version";
  assert.equal(
    (await compareSettlementState(f.context, transport, now)).ledgerVersion,
    "18446744073709551615",
  );
  const before = calls;
  for (const invalid of [
    { ...f.context, token: "lookalike-usdc.near" },
    { ...f.context, manifest: "local-v1" },
    { ...f.context, domain: "showup.sandbox.authorization.v1" },
  ])
    await assert.rejects(() => compareSettlementState(invalid, transport, now));
  await assert.rejects(() =>
    compareSettlementState({ ...f.context, environment: "sandbox" }, transport, now),
  );
  assert.equal(calls, before, "sandbox metadata cannot cause a public RPC call");
  f = settlementFixture(now, "engineering");
  expectedChain = "testnet";
  mode = "valid";
  const engineering = await compareEngineeringSettlementState(f.context, transport, now);
  assert.deepEqual(engineering.sourceIds, ["near-testnet-archival", "near-testnet-fastnear"]);
  assert.equal(engineering.registration?.booked, true);
  assert.equal(engineering.sourceQualified, false);
  assert.equal(engineering.fundingAllowed, false);
  const engineeringCalls = calls;
  await assert.rejects(compareSettlementState(f.context, transport, now));
  assert.equal(calls, engineeringCalls, "engineering state cannot enter the mainnet read path");
});
