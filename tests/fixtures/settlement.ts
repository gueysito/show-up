import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import type {
  SettlementContext,
  SettlementViews,
} from "../../src/server/protocol/settlement-state";
import { manifestHash, networkManifest } from "../../src/server/protocol/manifest";

export function settlementFixture(
  now = Date.now(),
  environment: "sandbox" | "mainnet" = "sandbox",
) {
  const id = (number: number) => number.toString(16).padStart(64, "0");
  const deployment = "fictional-escrow.near",
    token = environment === "mainnet" ? networkManifest.settlement.contract : "fictional-usdc.near";
  const selected = { network: "near", asset: token, address: "fictional-wallet.near" };
  const material = {
    event: id(1),
    host: "fictional-host.near",
    mode: "online",
    capacity: 1,
    principal: "5000000",
    sponsor_budget: "0",
    sponsor_return: { ...selected, address: "fictional-sponsor.near" },
    start_ms: now + 900_000,
    end_ms: now + 4_500_000,
    latest_quiz_close_ms: 0,
    excluded: [],
    draw_policy: null,
    custody_proof_policy: null,
    native_nft: null,
    observer_policy: null,
  };
  const domain =
      environment === "mainnet" ? networkManifest.signingDomain : "showup.sandbox.authorization.v1",
    manifest = environment === "mainnet" ? manifestHash : "local-v1";
  const rulesHash = canonicalHash({
    format: "showup.event.rules.v1",
    authorization_domain: domain,
    deployment,
    manifest,
    settlement_token: token,
    terms: material,
  });
  const authorization = {
    domain,
    deployment,
    manifest,
    event: material.event,
    rules_hash: rulesHash,
    registration: id(10),
    participant: id(1010),
    wallet_tag: id(2010),
    principal: "5000000",
    source: { ...selected },
    refund: { ...selected },
    payout: { ...selected },
    fee_cap: "100000",
    nonce: id(3010),
    expires_ms: material.start_ms,
    reservation_ms: now + 240_000,
  };
  const context: SettlementContext = {
    environment,
    deployment,
    token,
    domain,
    manifest,
    event: material.event,
    rulesHash,
    authorization,
    escrowCodeHash: encodeBase58(Buffer.alloc(32, 3)),
    tokenCodeHash: encodeBase58(Buffer.alloc(32, 4)),
  };
  const block = { height: "100", hash: encodeBase58(Buffer.alloc(32, 7)), timestampMs: now - 1000 };
  const views: SettlementViews = {
    event: {
      terms: { ...material, rules_hash: rulesHash },
      status: "published",
      sponsor_received: "0",
      reserved: [],
      funded: [authorization.registration],
      attendance: 0,
      ledger_version: 1,
      ended_ms: null,
    },
    registration: {
      authorization: structuredClone(authorization),
      state: "funded",
      attendance: null,
    },
    principal: null,
    returned: null,
    accounting: { received: "5000000", delivered: "0", owed: "0", unallocated: "5000000" },
    tokenBalance: "5000000",
  };
  return { context, views, block };
}

// Captures one immutable sample for mock RPC/race checks. No public network.
export function settlementTransport(
  input: ReturnType<typeof settlementFixture>,
  options: {
    second?: ReturnType<typeof settlementFixture>["views"];
    fail?: boolean;
    wait?: () => Promise<void>;
  } = {},
): typeof fetch {
  const sample = structuredClone(input),
    secondViews = structuredClone(options.second);
  return async (url, request) => {
    await options.wait?.();
    const body = JSON.parse(String(request?.body)),
      second = new URL(String(url)).hostname.includes("fastnear");
    if (options.fail)
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message: "Controlled source outage" },
      });
    const { context, block } = sample,
      views = second && secondViews ? secondViews : sample.views;
    let result: unknown;
    if (body.method === "status") result = { chain_id: "mainnet" };
    else if (body.method === "block")
      result = {
        header: {
          height: Number(block.height),
          hash: block.hash,
          timestamp_nanosec: (BigInt(block.timestampMs) * 1_000_000n).toString(),
        },
      };
    else if (body.method === "query" && body.params.block_id === block.hash) {
      if (body.params.request_type === "view_account")
        result = {
          block_hash: block.hash,
          block_height: Number(block.height),
          code_hash:
            body.params.account_id === context.deployment
              ? context.escrowCodeHash
              : context.tokenCodeHash,
        };
      else {
        const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
        let value: unknown;
        switch (body.params.method_name) {
          case "get_event":
            value = views.event;
            break;
          case "get_registration":
            value = views.registration;
            break;
          case "get_liability":
            value = args.id.endsWith(":principal") ? views.principal : views.returned;
            break;
          case "accounting":
            value = views.accounting;
            break;
          case "ft_balance_of":
            value = views.tokenBalance;
            break;
          default:
            throw new Error("Unexpected mock view");
        }
        result = {
          block_hash: block.hash,
          block_height: Number(block.height),
          result: [...Buffer.from(JSON.stringify(value))],
        };
      }
    } else throw new Error("Unexpected mock RPC");
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
}
