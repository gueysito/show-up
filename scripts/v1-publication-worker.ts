import {
  readV1Reserves,
  v1ControllerSigningFloor,
  v1PilotReserveTarget,
} from "../src/server/protocol/v1-reserves";
import { V1ReadOnlyRpc, v1PacedSubmission } from "../src/server/protocol/v1-rpc";
import { setTimeout as pause } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadAuthEnvironment, privateWorkerEnvironment } from "./auth-environment";
import { databaseConfig } from "../src/server/config";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { record } from "../src/server/protocol/quote-signature";
import { unsigned } from "../src/server/protocol/rpc";
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
import { runV1Action, type V1ActionGateway } from "../src/worker/v1-actions";
import { readV1ActionSnapshot, enqueueV1Deadline } from "../src/server/events/v1-actions";
import { validateV1Action, observeV1Action } from "../src/worker/v1-action-observation";
import {
  readV1NftHolding,
  prepareV1NftTransfer,
  v1NftCustody,
} from "../src/server/protocol/v1-nft";
import { runV1NftDelivery, v1NftDeliveryGateway } from "../src/worker/v1-nft-delivery";
import { enqueueV1IntentsWithdrawal, runV1IntentsQueue } from "../src/worker/v1-intents";
import { v1IntentsGateway } from "./lib/v1-intents-gateway";

export async function signV1OwnerCalls(
  snapshot: Awaited<ReturnType<typeof readV1Snapshot>>,
  actions: NativeAction[],
) {
  const client = new V1ReadOnlyRpc("near-fastnear");
  const protocol = record(
    await client.read("EXPERIMENTAL_protocol_config", { block_id: snapshot.block.hash }),
  );
  if (
    protocol.chain_id !== "mainnet" ||
    protocol.protocol_version !== v1Deployment.protocolVersion ||
    unsigned(record(protocol.runtime_config).min_gas_purchase_price) > 1_000_000_000n
  )
    throw new Error("V1 gas purchase policy changed");
  const keys = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (id) => {
      const rpc = new V1ReadOnlyRpc(id),
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
        unsigned(record(account).amount, 128) < v1ControllerSigningFloor
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
      let selected =
        phase === "atomic" ? actions : phase === "create" ? [actions[0]] : [actions[1]];
      if (image.terms.nft) {
        if (phase === "atomic") throw new Error("NFT custody must precede publication");
        const holding = await readV1NftHolding(image.terms.nft);
        if (phase === "create") {
          if (holding.owner !== image.terms.nft.contributor)
            throw new Error("NFT contributor no longer holds the asset");
          selected.push({
            kind: "call",
            method: "derive_nft_custody",
            args: Buffer.from(canonicalJson({ event: image.eventId })),
            gas: "50000000000000",
            deposit: "0",
          });
        } else {
          if (holding.owner !== v1NftCustody(record(snapshot.event!.nft)))
            throw new Error("NFT custody not confirmed on Ethereum");
          await prepareV1NftTransfer(image.terms.nft, holding.owner, image.terms.nft.contributor);
          selected = [
            {
              kind: "call",
              method: "confirm_nft_custody",
              args: Buffer.from(canonicalJson({ event: image.eventId })),
              gas: "10000000000000",
              deposit: "0",
            },
            ...selected,
          ];
        }
      }
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
      const response = await v1PacedSubmission(() =>
        fetch(v1Deployment.writeOrigin, {
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
        }),
      );
      if (response.status !== 200)
        throw new Error("Reconcile the original publication transaction");
      const result = record(await response.json());
      if (result.id !== "v1-publication" || result.error)
        throw new Error("Reconcile the original publication transaction");
    },
    final: v1FinalTransaction,
  };
}

export async function v1FinalTransaction(
  image: { hash: string },
  sender: string = v1Deployment.owner,
) {
  const client = new V1ReadOnlyRpc("near-fastnear");
  const result = record(
    await client.read("tx", {
      tx_hash: image.hash,
      sender_account_id: sender,
      wait_until: "FINAL",
    }),
  );
  if (
    record(result.transaction).hash !== image.hash ||
    record(result.transaction).signer_id !== sender ||
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
        return Object.hasOwn(status, "SuccessValue") || Object.hasOwn(status, "SuccessReceiptId");
      }),
    minimumHeight: heights.reduce((a, b) => (a > b ? a : b), 0n).toString(),
    gasYoctoNear: outcomes
      .reduce((sum, value) => sum + unsigned(record(value.outcome).tokens_burnt, 128), 0n)
      .toString(),
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
                ethereum: image.ethereum?.address ?? null,
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

export function v1ActionGateway(pool: pg.Pool, key: string): V1ActionGateway {
  const native = v1PublicationGateway();
  return {
    submit: native.submit,
    final: native.final,
    async prepare(image) {
      const { snapshot } = await readV1ActionSnapshot(pool, key, image.eventId);
      await validateV1Action(image, snapshot);
      const parameter =
        image.kind === "check_in" ? "registration" : image.kind === "withdraw" ? "claim" : "event";
      const nftMethod =
        image.kind === "nft_release"
          ? "release_nft"
          : image.kind === "nft_retry"
            ? "retry_nft_signature"
            : image.kind === "nft_derive"
              ? "derive_nft_custody"
              : null;
      const custodyConfirmation: NativeAction[] = [];
      if (image.kind === "nft_release") {
        const nft = record(snapshot.event!.nft);
        if (
          (await readV1NftHolding(nft as Parameters<typeof readV1NftHolding>[0])).owner !==
          v1NftCustody(nft)
        )
          throw new Error("NFT is no longer held in custody");
        if (nft.held !== true)
          custodyConfirmation.push({
            kind: "call",
            method: "confirm_nft_custody",
            args: Buffer.from(canonicalJson({ event: image.eventId })),
            gas: "10000000000000",
            deposit: "0",
          });
      }
      return {
        ...(await signV1OwnerCalls(snapshot, [
          ...custodyConfirmation,
          {
            kind: "call",
            method: nftMethod ?? image.kind,
            args: Buffer.from(
              canonicalJson(
                nftMethod
                  ? {
                      event: image.eventId,
                      ...(image.kind === "nft_release"
                        ? {
                            ...image.nft!.envelope,
                            nonce: Number(image.nft!.envelope.nonce),
                            gas_limit: Number(image.nft!.envelope.gas_limit),
                          }
                        : {}),
                    }
                  : { [parameter]: image.target },
              ),
            ),
            gas:
              image.kind === "withdraw" ||
              image.kind === "nft_release" ||
              image.kind === "nft_retry"
                ? "100000000000000"
                : image.kind === "nft_derive"
                  ? "50000000000000"
                  : "30000000000000",
            deposit: image.kind === "nft_release" || image.kind === "nft_retry" ? "1" : "0",
          },
        ])),
        semantic: canonicalHash(image),
      };
    },
    async observe(image, minimumHeight) {
      const { snapshot } = await readV1ActionSnapshot(pool, key, image.eventId);
      return observeV1Action(image, snapshot, minimumHeight);
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
  const hosted = process.env.SHOWUP_ENV === "production";
  const env = hosted ? process.env : privateWorkerEnvironment(await loadAuthEnvironment());
  const database = databaseConfig(env);
  if (hosted) {
    if (
      env.SHOWUP_AUTH === "1" ||
      env.SHOWUP_GOOGLE_CLIENT_SECRET ||
      env.SHOWUP_TELEGRAM_CLIENT_SECRET ||
      env.SHOWUP_IDENTITY_INDEX_KEY ||
      !/^[a-f0-9]{64}$/.test(env.SHOWUP_IDENTITY_KEY ?? "")
    )
      throw new Error("Hosted worker requires its own private configuration");
    await loadV1MainnetKey();
  }
  const pool = new pg.Pool({
    ...database,
    max: 3,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  let stopping = false;
  let lastNftCheck = 0;
  let lastRouteCheck = 0;
  let lastReserveCheck = 0;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopping = true;
    });
  try {
    if (hosted) {
      await pool.query("SELECT funding_transaction_hash FROM app_v1_registrations LIMIT 0");
      console.log("Showup V1 worker ready");
    }
    do {
      if (hosted && Date.now() - lastReserveCheck >= 300_000) {
        lastReserveCheck = Date.now();
        try {
          const reserves = await readV1Reserves();
          for (const account of ["escrow", "controller"] as const)
            if (reserves[account] < v1PilotReserveTarget[account])
              console.warn(
                `V1 reserve below pilot target: ${account}. Available: ${reserves[account]} yoctoNEAR; target: ${v1PilotReserveTarget[account]} yoctoNEAR.`,
              );
        } catch {
          console.warn(
            "V1 reserve check unavailable. Verify finalized balances before opening deposits.",
          );
        }
      }
      try {
        const account = await runV1IntentsQueue(
          pool,
          env.SHOWUP_IDENTITY_KEY!,
          "route_account",
          v1IntentsGateway("route_account", {
            submit: v1PublicationGateway().submit,
            final: v1FinalTransaction,
          }),
        );
        if (!["idle", "busy"].includes(account.state)) console.log(JSON.stringify(account));
      } catch {
        console.error(
          "Route account retained for original-hash reconciliation; no duplicate funding or key creation.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
        else await pause(30000);
      }
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
        else await pause(30000);
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
      try {
        await enqueueV1Deadline(pool, env.SHOWUP_IDENTITY_KEY!);
        const action = await runV1Action(
          pool,
          env.SHOWUP_IDENTITY_KEY!,
          v1ActionGateway(pool, env.SHOWUP_IDENTITY_KEY!),
        );
        if (!["idle", "busy"].includes(action.state)) console.log(JSON.stringify(action));
      } catch {
        console.error(
          "Event action retained for original-hash reconciliation. No replacement nonce or automatic resend.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
        else await pause(30000);
      }
      try {
        if (Date.now() - lastRouteCheck >= 15000) {
          lastRouteCheck = Date.now();
          await enqueueV1IntentsWithdrawal(pool, env.SHOWUP_IDENTITY_KEY!);
        }
      } catch {
        console.error(
          "Intents balance check unavailable; existing route transactions remain retained.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
      }
      try {
        const forwarded = await runV1IntentsQueue(
          pool,
          env.SHOWUP_IDENTITY_KEY!,
          "route_withdrawal",
          v1IntentsGateway("route_withdrawal", {
            submit: v1PublicationGateway().submit,
            final: v1FinalTransaction,
          }),
        );
        if (!["idle", "busy"].includes(forwarded.state)) console.log(JSON.stringify(forwarded));
      } catch {
        console.error(
          "Intents withdrawal retained for original-hash reconciliation; no replacement nonce or automatic resend.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
      }
      try {
        if (Date.now() - lastNftCheck >= 15000) {
          lastNftCheck = Date.now();
          const delivery = await runV1NftDelivery(
            pool,
            env.SHOWUP_IDENTITY_KEY!,
            v1NftDeliveryGateway(pool, env.SHOWUP_IDENTITY_KEY!),
          );
          if (!["idle", "busy", "waiting"].includes(delivery.state))
            console.log(JSON.stringify(delivery));
        }
      } catch {
        console.error(
          "NFT delivery retained for original-hash reconciliation. No automatic resend or replacement transaction.",
        );
        if (!args.includes("--watch")) process.exitCode = 1;
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
    console.error("Private V1 worker refused. Check its configuration, signer and migrations.");
    process.exitCode = 1;
  });
