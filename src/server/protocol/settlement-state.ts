import { canonicalHash, canonicalJson } from "./canonical";
import { decodeBase58 } from "./encoding";
import {
  compareFinalizedHeads,
  FinalizedSourceConflict,
  type FinalizedHeader,
} from "./finalized-heads";
import { record } from "./quote-signature";
import { integerAmount } from "./one-click";
import { parseRpcJson, ReadOnlyRpc, unsigned } from "./rpc";
import { walletAddress } from "../wallets/proof";
import { manifestHash, networkManifest, type Network } from "./manifest";

export type SettlementContext = {
  environment: "mainnet" | "sandbox";
  deployment: string;
  token: string;
  domain: string;
  manifest: string;
  event: string;
  rulesHash: string;
  escrowCodeHash: string;
  tokenCodeHash: string;
  authorization: Record<string, unknown>;
};
export type SettlementViews = {
  event: unknown;
  registration: unknown;
  principal: unknown;
  returned: unknown;
  accounting: unknown;
  tokenBalance: unknown;
};
function exact(value: unknown, fields: string) {
  const parsed = record(value);
  if (Object.keys(parsed).sort().join() !== fields) throw new Error("Unexpected settlement fields");
  return parsed;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error("Invalid settlement credential");
  return value;
}
function time(value: unknown) {
  const result = unsigned(value, 64);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe settlement time");
  return Number(result);
}
function destination(value: unknown) {
  const result = exact(value, "address,asset,network");
  if (
    typeof result.asset !== "string" ||
    !result.asset ||
    result.asset.length > 128 ||
    typeof result.address !== "string" ||
    walletAddress(result.network as Network, result.address) !== result.address
  )
    throw new Error("Invalid settlement destination");
  return result;
}
function context(value: SettlementContext) {
  exact(
    value,
    "authorization,deployment,domain,environment,escrowCodeHash,event,manifest,rulesHash,token,tokenCodeHash",
  );
  for (const account of [value.deployment, value.token]) walletAddress("near", account);
  for (const hash of [value.escrowCodeHash, value.tokenCodeHash]) decodeBase58(hash, 32);
  if (
    !["mainnet", "sandbox"].includes(value.environment) ||
    typeof value.domain !== "string" ||
    !value.domain ||
    value.domain.length > 128 ||
    typeof value.manifest !== "string" ||
    !value.manifest ||
    value.manifest.length > 128
  )
    throw new Error("Invalid settlement context");
  id(value.event);
  id(value.rulesHash);
  if (
    value.environment === "mainnet" &&
    (value.token !== networkManifest.settlement.contract ||
      value.manifest !== manifestHash ||
      value.domain !== networkManifest.signingDomain)
  )
    throw new Error("Mainnet settlement profile does not match the frozen manifest");
  const auth = exact(
    value.authorization,
    "deployment,domain,event,expires_ms,fee_cap,manifest,nonce,participant,payout,principal,refund,registration,reservation_ms,rules_hash,source,wallet_tag",
  );
  if (
    auth.domain !== value.domain ||
    auth.deployment !== value.deployment ||
    auth.manifest !== value.manifest ||
    auth.event !== value.event ||
    auth.rules_hash !== value.rulesHash
  )
    throw new Error("Wrong settlement authorization context");
  for (const field of ["registration", "participant", "wallet_tag", "nonce"]) id(auth[field]);
  if (
    integerAmount(auth.principal) === 0n ||
    integerAmount(auth.fee_cap) >= integerAmount(auth.principal) ||
    time(auth.reservation_ms) > time(auth.expires_ms)
  )
    throw new Error("Invalid settlement authorization bounds");
  for (const field of ["source", "refund", "payout"]) {
    const selected = destination(auth[field]);
    if (selected.network === "near" && selected.asset !== value.token)
      throw new Error("Wrong settlement asset");
  }
  if (destination(auth.source).network !== "near")
    throw new Error("External source attribution remains unqualified");
  return auth;
}

export function settlementContextHash(value: SettlementContext) {
  context(value);
  return canonicalHash(value);
}

export class SettlementSourceConflict extends Error {}
function ids(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid settlement seat count");
  const values = value.map(id);
  if (new Set(values).size !== values.length) throw new Error("Duplicate settlement seat");
  return values;
}
function liability(value: unknown, expectedDestination: unknown) {
  if (value === null) return null;
  const parsed = exact(value, "attempts,destination,paid,pending,total");
  if (
    canonicalJson(destination(parsed.destination)) !==
    canonicalJson(destination(expectedDestination))
  )
    throw new Error("Liability destination changed");
  const total = integerAmount(parsed.total),
    paid = integerAmount(parsed.paid),
    attempts = unsigned(parsed.attempts, 64);
  if (total === 0n || paid > total) throw new Error("Invalid settlement liability");
  let pending: { number: string; amount: string } | null = null;
  if (parsed.pending !== null) {
    const attempt = exact(parsed.pending, "amount,number"),
      amount = integerAmount(attempt.amount),
      number = unsigned(attempt.number, 64);
    if (number === 0n || number !== attempts || amount === 0n || amount > total - paid)
      throw new Error("Invalid pending settlement attempt");
    pending = { number: number.toString(), amount: amount.toString() };
  }
  return {
    gross: total.toString(),
    paid: paid.toString(),
    remaining: (total - paid).toString(),
    attempts: attempts.toString(),
    pending,
  };
}

// Interprets contract-owned state; it does not allocate seats from provider status
// or transaction hashes. Pure validation is also used on actual sandbox exports.
export function validateSettlementState(
  expected: SettlementContext,
  views: SettlementViews,
  block: FinalizedHeader,
) {
  const auth = context(expected);
  decodeBase58(block.hash, 32);
  unsigned(block.height, 64);
  if (!Number.isSafeInteger(block.timestampMs) || block.timestampMs < 0)
    throw new Error("Invalid settlement block time");
  const event = exact(
    views.event,
    "attendance,ended_ms,funded,ledger_version,reserved,sponsor_received,status,terms",
  );
  const terms = record(event.terms),
    material = { ...terms };
  delete material.rules_hash;
  if (
    terms.event !== expected.event ||
    terms.rules_hash !== expected.rulesHash ||
    canonicalHash({
      format: "showup.event.rules.v1",
      authorization_domain: expected.domain,
      deployment: expected.deployment,
      manifest: expected.manifest,
      settlement_token: expected.token,
      terms: material,
    }) !== expected.rulesHash ||
    terms.principal !== auth.principal
  )
    throw new Error("Frozen settlement rules changed");
  const funded = ids(event.funded),
    reserved = ids(event.reserved),
    seats = [...funded, ...reserved];
  const capacity = Number(unsigned(terms.capacity, 64)),
    start = time(terms.start_ms),
    end = time(terms.end_ms);
  if (
    capacity < 1 ||
    capacity > 100 ||
    seats.length > capacity ||
    new Set(seats).size !== seats.length ||
    !["online", "physical"].includes(String(terms.mode)) ||
    end - start < 1_800_000 ||
    end - start > 7_200_000 ||
    time(auth.reservation_ms) > start ||
    !["draft", "published", "closed", "cancelled", "aborted"].includes(String(event.status))
  )
    throw new Error("Invalid settlement capacity or schedule");
  const attendance = Number(unsigned(event.attendance, 64));
  if (
    attendance > funded.length ||
    unsigned(event.ledger_version, 64) < BigInt(funded.length + attendance) ||
    (event.status === "draft" && funded.length > 0) ||
    (event.ended_ms !== null &&
      (time(event.ended_ms) < start || time(event.ended_ms) > block.timestampMs))
  )
    throw new Error("Invalid settlement attendance or end");
  const budget = integerAmount(terms.sponsor_budget),
    sponsor = integerAmount(event.sponsor_received);
  if (
    (sponsor !== 0n && sponsor !== budget) ||
    (["published", "closed"].includes(String(event.status)) && sponsor !== budget)
  )
    throw new Error("Sponsor budget is not escrowed");
  const registrationId = String(auth.registration),
    inFunded = funded.includes(registrationId),
    inReserved = reserved.includes(registrationId);
  let registration: {
    state: string;
    attendance: string | null;
    reservedUntil: number | null;
    booked: boolean;
    authorizationHash: string;
  } | null = null;
  const principal = liability(views.principal, auth.payout),
    returned = liability(views.returned, auth.refund);
  if (views.registration !== null) {
    const entry = exact(views.registration, "attendance,authorization,state");
    if (canonicalJson(entry.authorization) !== canonicalJson(auth))
      throw new Error("Registration authorization changed");
    const state = String(entry.state);
    if (
      !["reserved", "return_only", "funded", "released", "refund_owed", "forfeiture_held"].includes(
        state,
      ) ||
      ![null, "on_time", "late"].includes(entry.attendance as null) ||
      ["funded", "refund_owed", "forfeiture_held"].includes(state) !== inFunded ||
      (inReserved && state !== "reserved") ||
      (state === "funded" && event.status !== "published") ||
      (state === "refund_owed" &&
        !["closed", "cancelled", "aborted"].includes(String(event.status))) ||
      (state === "forfeiture_held" && event.status !== "closed") ||
      (entry.attendance !== null &&
        (attendance === 0 || !["funded", "refund_owed"].includes(state)))
    )
      throw new Error("Contradictory settlement registration");
    if (["released", "refund_owed"].includes(state)) {
      if (!principal || principal.gross !== auth.principal)
        throw new Error("Principal recovery liability missing");
    } else if (principal) throw new Error("Unexpected principal liability");
    registration = {
      state,
      attendance: entry.attendance as string | null,
      reservedUntil:
        inReserved && event.status === "published" && block.timestampMs < time(auth.reservation_ms)
          ? time(auth.reservation_ms)
          : null,
      booked: state === "funded" && inFunded,
      authorizationHash: canonicalHash(auth),
    };
  } else if (inFunded || inReserved || principal || returned)
    throw new Error("Missing registration for settlement funds");
  const ledger = exact(views.accounting, "delivered,owed,received,unallocated");
  const received = integerAmount(ledger.received),
    delivered = integerAmount(ledger.delivered),
    owed = integerAmount(ledger.owed),
    unallocated = integerAmount(ledger.unallocated),
    balance = integerAmount(views.tokenBalance);
  if (
    received !== delivered + owed + unallocated ||
    balance < received - delivered ||
    received < integerAmount(auth.principal) * BigInt(funded.length) + sponsor ||
    (["draft", "published"].includes(String(event.status)) &&
      unallocated < integerAmount(auth.principal) * BigInt(funded.length) + sponsor) ||
    owed < BigInt(principal?.remaining ?? "0") + BigInt(returned?.remaining ?? "0")
  )
    throw new Error("Settlement conservation failed");
  return {
    event: expected.event,
    rulesHash: expected.rulesHash,
    registrationId,
    eventState: String(event.status),
    mode: String(terms.mode),
    capacity,
    funded,
    reserved,
    ledgerVersion: unsigned(event.ledger_version, 64).toString(),
    attendance,
    sponsorReceived: sponsor.toString(),
    registration,
    principal,
    returned,
    accounting: {
      received: received.toString(),
      delivered: delivered.toString(),
      owed: owed.toString(),
      unallocated: unallocated.toString(),
    },
    tokenBalance: balance.toString(),
    block: { ...block },
    sourceQualified: false as const,
    fundingAllowed: false as const,
  };
}

function decodeView(raw: unknown, block: FinalizedHeader) {
  const value = record(raw);
  if (
    value.block_hash !== block.hash ||
    unsigned(value.block_height, 64).toString() !== block.height ||
    !Array.isArray(value.result) ||
    value.result.length > 131072 ||
    value.result.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw new Error("Settlement view block or size mismatch");
  const bytes = Buffer.from(value.result),
    text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Invalid settlement view encoding");
  return parseRpcJson(text);
}

// Fixed public mainnet sources only. Code hashes and exact state agree at one
// finalized block, but code authority, source independence and G1 remain unqualified.
export async function compareSettlementState(
  input: SettlementContext,
  transport: typeof fetch = fetch,
  now = Date.now(),
) {
  const expected = structuredClone(input);
  context(expected);
  if (expected.environment !== "mainnet")
    throw new Error("Public settlement reads require an explicit mainnet profile");
  const first = new ReadOnlyRpc("near-public", transport),
    second = new ReadOnlyRpc("near-fastnear", transport);
  const signal = AbortSignal.timeout(30_000);
  const compared = await compareFinalizedHeads("near", first, second, now, signal).catch(
    (error) => {
      if (error instanceof FinalizedSourceConflict)
        throw new SettlementSourceConflict("Finalized settlement sources disagree");
      throw error;
    },
  );
  const block = compared.block;
  const read = async (client: ReadOnlyRpc) => {
    for (const [account, hash] of [
      [expected.deployment, expected.escrowCodeHash],
      [expected.token, expected.tokenCodeHash],
    ]) {
      const value = record(
        await client.read(
          "query",
          { request_type: "view_account", account_id: account, block_id: block.hash },
          signal,
        ),
      );
      if (
        value.block_hash !== block.hash ||
        unsigned(value.block_height, 64).toString() !== block.height
      )
        throw new Error("Settlement code view block changed");
      if (value.code_hash !== hash)
        throw new SettlementSourceConflict("Frozen settlement code changed");
    }
    const call = async (account: string, method: string, args: object) =>
      decodeView(
        await client.read(
          "query",
          {
            request_type: "call_function",
            account_id: account,
            method_name: method,
            args_base64: Buffer.from(canonicalJson(args)).toString("base64"),
            block_id: block.hash,
          },
          signal,
        ),
        block,
      );
    const registration = expected.authorization.registration;
    const [event, entry, principal, returned, accounting, tokenBalance] = await Promise.all([
      call(expected.deployment, "get_event", { event: expected.event }),
      call(expected.deployment, "get_registration", { registration }),
      call(expected.deployment, "get_liability", { id: `${registration}:principal` }),
      call(expected.deployment, "get_liability", { id: `${registration}:return` }),
      call(expected.deployment, "accounting", {}),
      call(expected.token, "ft_balance_of", { account_id: expected.deployment }),
    ]);
    return validateSettlementState(
      expected,
      { event, registration: entry, principal, returned, accounting, tokenBalance },
      block,
    );
  };
  const [a, b] = await Promise.all([read(first), read(second)]);
  if (canonicalJson(a) !== canonicalJson(b))
    throw new SettlementSourceConflict("Finalized settlement sources disagree");
  return {
    ...a,
    stateHash: canonicalHash(a),
    sourceIds: compared.sourceIds,
    operatorClaims: compared.operatorClaims,
  };
}
