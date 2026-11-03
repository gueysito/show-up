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
