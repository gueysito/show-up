import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadAuthEnvironment, privateWorkerEnvironment } from "./auth-environment";
import { databaseConfig } from "../src/server/config";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { record } from "../src/server/protocol/quote-signature";
import { ReadOnlyRpc, unsigned } from "../src/server/protocol/rpc";
import {
  matchesV1Terms,
  readV1Record,
  readV1Snapshot,
  v1Deployment,
} from "../src/server/protocol/v1-escrow";
import { runV1Publication, type V1PublicationGateway } from "../src/worker/v1-publication";
import { signV1MainnetTransaction, type NativeAction } from "./lib/native-engineering-transaction";
import { loadV1MainnetKey } from "./lib/v1-mainnet-key";
import { runV1Registration } from "../src/worker/v1-registration";
import type { V1RegistrationGateway } from "../src/worker/v1-registration";
import { AppFailure } from "../src/server/http/security";

export async function signV1OwnerCalls(
  snapshot: Awaited<ReturnType<typeof readV1Snapshot>>,
  actions: NativeAction[],
) {
  const client = new ReadOnlyRpc("near-fastnear");
  const protocol = record(
    await client.read("EXPERIMENTAL_protocol_config", { block_id: snapshot.block.hash }),
  );
  if (
    protocol.chain_id !== "mainnet" ||
    protocol.protocol_version !== 87 ||
    unsigned(record(protocol.runtime_config).min_gas_purchase_price) > 1_000_000_000n
  )
    throw new Error("V1 gas purchase policy changed");
  const keys = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (id) => {
      const rpc = new ReadOnlyRpc(id),
        params = { account_id: v1Deployment.owner, block_id: snapshot.block.hash };
      const [account, list] = await Promise.all([
        rpc.read("query", { ...params, request_type: "view_account" }),
        rpc.read("query", { ...params, request_type: "view_access_key_list" }),
      ]);
      for (const value of [account, list])
        if (
          record(value).block_hash !== snapshot.block.hash ||
          String(record(value).block_height) !== snapshot.block.height
        )
          throw new Error("V1 signer query block mismatch");
      const entries = record(list).keys;
      if (
        !Array.isArray(entries) ||
        entries.length !== 1 ||
        record(entries[0]).public_key !== v1Deployment.publicKey ||
        record(record(entries[0]).access_key).permission !== "FullAccess" ||
        record(account).code_hash !== "1".repeat(32) ||
        unsigned(record(account).amount, 128) < 200_000_000_000_000_000_000_000n
      )
        throw new Error("V1 signer authority or gas reserve changed");
      return unsigned(record(record(entries[0]).access_key).nonce, 64).toString();
    }),
  );
  if (keys[0] !== keys[1]) throw new Error("V1 nonce sources disagree");
  return {
    ...signV1MainnetTransaction(
      {
        signer: v1Deployment.owner,
        receiver: v1Deployment.account,
        blockHash: snapshot.block.hash,
        nonce: (BigInt(keys[0]) + 1n).toString(),
        actions,
      },
      await loadV1MainnetKey(),
    ),
    validUntilMs: Date.now() + 120000,
  };
}

export function v1PublicationGateway(): V1PublicationGateway {
  const client = new ReadOnlyRpc("near-fastnear");
  return {
    snapshot: readV1Snapshot,
    async prepare(image, phase = "atomic") {
      const snapshot = await readV1Snapshot(image.eventId);
      if (phase !== "publish" && snapshot.event)
        throw new Error("V1 event already exists; reconcile without another transaction");
      if (
        phase === "publish" &&
        (!snapshot.event ||
          snapshot.event.status !== "draft" ||
          snapshot.event.prize_received !== true ||
          !matchesV1Terms(snapshot.event, image.terms))
      )
        throw new Error("V1 exact prize funding is not confirmed");
      const actions: NativeAction[] = [
        {
          kind: "call",
          method: "create_event",
          args: Buffer.from(canonicalJson({ terms: image.terms })),
          gas: "30000000000000",
          deposit: "0",
        },
        {
          kind: "call",
          method: "publish",
          args: Buffer.from(canonicalJson({ event: image.eventId })),
          gas: "30000000000000",
          deposit: "0",
        },
      ];
      const selected =
        phase === "atomic" ? actions : phase === "create" ? [actions[0]] : [actions[1]];
      const signed = await signV1OwnerCalls(snapshot, selected);
      return {
        ...signed,
        semantic: canonicalHash(image.terms),
        validUntilMs: Date.now() + 120_000,
        phase,
      };
    },
    async submit(image) {
      // A single write, with no transport retries. Subsequent runs only call tx.
      const response = await fetch(v1Deployment.writeOrigin, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "v1-publication",
          method: "send_tx",
          params: { signed_tx_base64: image.signedBase64, wait_until: "NONE" },
        }),
      });
      if (response.status !== 200)
        throw new Error("Reconcile the original publication transaction");
      const result = record(await response.json());
      if (result.id !== "v1-publication" || result.error)
        throw new Error("Reconcile the original publication transaction");
    },
    async final(image) {
      const result = record(
        await client.read("tx", {
          tx_hash: image.hash,
          sender_account_id: v1Deployment.owner,
          wait_until: "FINAL",
        }),
      );
      if (
        record(result.transaction).hash !== image.hash ||
        result.final_execution_status !== "FINAL" ||
        !Array.isArray(result.receipts_outcome)
      )
        throw new Error("Original publication is not final yet");
      const outcomes = [result.transaction_outcome, ...result.receipts_outcome].map(record);
      if (outcomes.length > 32) throw new Error("Publication receipt count");
      const blocks = [...new Set(outcomes.map((value) => String(value.block_hash)))];
      const heights = await Promise.all(
        blocks.map(async (hash) => {
          const block = record(record(await client.read("block", { block_id: hash })).header);
          if (block.hash !== hash) throw new Error("Publication receipt block mismatch");
          return unsigned(block.height, 64);
        }),
      );
      return {
        success:
          Object.hasOwn(record(result.status), "SuccessValue") &&
          outcomes.every((value) => {
            const status = record(record(value.outcome).status);
            return (
              Object.hasOwn(status, "SuccessValue") || Object.hasOwn(status, "SuccessReceiptId")
            );
          }),
        minimumHeight: heights.reduce((a, b) => (a > b ? a : b), 0n).toString(),
        gasYoctoNear: outcomes
          .reduce((sum, value) => sum + unsigned(record(value.outcome).tokens_burnt, 128), 0n)
          .toString(),
      };
    },
  };
}

export function v1RegistrationGateway(): V1RegistrationGateway {
  const native = v1PublicationGateway();
  return {
    submit: native.submit,
    final: native.final,
    async prepare(image) {
      const snapshot = await readV1Snapshot(image.eventId);
      if (
        !snapshot.event ||
        snapshot.event.status !== "published" ||
        snapshot.event.deposit !== image.amount ||
        snapshot.event.start_ms !== image.startMs ||
        snapshot.block.timestampMs >= image.startMs ||
        snapshot.event.sponsor === image.payout ||
        snapshot.event.sponsor === image.sender
      )
        throw new AppFailure(409, "Registration live event terms changed");
      if (await readV1Record("get_registration", image.id, snapshot.block))
        throw new Error("Registration already exists; reconcile original image");
      return {
        ...(await signV1OwnerCalls(snapshot, [
          {
            kind: "call",
            method: "register",
            args: Buffer.from(
              canonicalJson({
                id: image.id,
                event: image.eventId,
                sender: image.sender,
                payout: image.payout,
                ethereum: null,
              }),
            ),
            gas: "30000000000000",
            deposit: "0",
          },
        ])),
        semantic: canonicalHash(image),
      };
    },
    async observe(image) {
      const snapshot = await readV1Snapshot(image.eventId);
      return {
        snapshot,
        registration: await readV1Record("get_registration", image.id, snapshot.block),
      };
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !["--execute", "--watch"].includes(arg)) ||
    new Set(args).size !== args.length
  )
    throw new Error("Use --execute and optionally --watch");
  if (!args.includes("--execute")) {
    console.log(
      "Read-only: no worker started. --execute processes one queued publication; --watch keeps checking.",
    );
    return;
  }
  const env = privateWorkerEnvironment(await loadAuthEnvironment());
  const pool = new pg.Pool({
    ...databaseConfig(env),
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopping = true;
    });
  try {
    do {
      try {
        const result = await runV1Publication(
          pool,
          env.SHOWUP_IDENTITY_KEY!,
          v1PublicationGateway(),
        );
        if (!["idle", "busy"].includes(result.state)) console.log(JSON.stringify(result));
      } catch {
        console.error(
          "Publication retained for original-hash reconciliation. No replacement nonce or automatic resend.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
      }
      try {
        const registration = await runV1Registration(
          pool,
          env.SHOWUP_IDENTITY_KEY!,
          v1RegistrationGateway(),
        );
        if (!["idle", "busy"].includes(registration.state))
          console.log(JSON.stringify(registration));
      } catch {
        console.error(
          "Registration retained for original-hash reconciliation. No replacement nonce or automatic resend.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
        else await pause(30_000);
      }
      if (!args.includes("--watch")) break;
      await pause(3000);
    } while (!stopping);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Private V1 worker refused. Check owner-only local configuration and migrations.",
    );
    process.exitCode = 1;
  });
