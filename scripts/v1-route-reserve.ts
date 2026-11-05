import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { V1ReadOnlyRpc } from "../src/server/protocol/v1-rpc";
import { readV1Snapshot, v1Deployment } from "../src/server/protocol/v1-escrow";
import { record } from "../src/server/protocol/quote-signature";
import { unsigned } from "../src/server/protocol/rpc";
import {
  v1DemoAccounts,
  v1DemoReserveTransaction,
  signV1IntentsTransaction,
} from "./lib/native-engineering-transaction";
import { loadV1MainnetKey } from "./lib/v1-mainnet-key";
import { mainnetJournal } from "../tests/fixtures/v1-mainnet";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length > 2 ||
    new Set(args).size !== args.length ||
    args.some((arg) => !["--execute", "--demo-b"].includes(arg))
  )
    throw new Error("Use --execute and optionally --demo-b for the fixed reserve transfer");
  const donorAccount = v1DemoAccounts[args.includes("--demo-b") ? 1 : 0],
    name = `route-native-reserve${args.includes("--demo-b") ? "-b" : ""}`,
    path = `contracts/.cache/v1-browser/${name}.json`;
  let previous: Awaited<ReturnType<typeof readFile>> | undefined;
  try {
    previous = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous) {
    const value = JSON.parse(previous.toString());
    if (value.images?.reserve) {
      const { v1FinalTransaction } = await import("./v1-publication-worker");
      const final = await v1FinalTransaction(value.images.reserve, donorAccount);
      console.log(
        JSON.stringify({
          phase: "original_reserve_reconciled",
          hash: value.images.reserve.hash,
          ...final,
        }),
      );
      return;
    }
    throw new Error("Existing reserve journal needs review; no fresh transfer");
  }
  const snapshot = await readV1Snapshot("00000000-0000-4000-8000-000000000004"),
    facts = await Promise.all(
      ["near-fastnear", "near-drpc"].map(async (endpoint) => {
        const rpc = new V1ReadOnlyRpc(endpoint),
          values = [];
        for (const account_id of [donorAccount, v1Deployment.account]) {
          const params = { account_id, block_id: snapshot.block.hash },
            [account, list] = await Promise.all([
              rpc.read("query", { ...params, request_type: "view_account" }),
              rpc.read("query", { ...params, request_type: "view_access_key_list" }),
            ]);
          for (const value of [account, list])
            if (record(value).block_hash !== snapshot.block.hash)
              throw new Error("Reserve account block mismatch");
          const keys = record(list).keys;
          if (
            record(account).code_hash !==
              (account_id === v1Deployment.account ? v1Deployment.codeHash : "1".repeat(32)) ||
            !Array.isArray(keys) ||
            keys.length !== 1 ||
            record(keys[0]).public_key !== v1Deployment.publicKey ||
            record(record(keys[0]).access_key).permission !== "FullAccess"
          )
            throw new Error("Reserve account authority changed");
          values.push({
            account: account_id,
            nonce: unsigned(record(record(keys[0]).access_key).nonce, 64).toString(),
            amount: unsigned(record(account).amount, 128).toString(),
            liquid: (
              unsigned(record(account).amount, 128) -
              unsigned(record(account).storage_usage, 64) * 10000000000000000000n
            ).toString(),
          });
        }
        return values;
      }),
    );
  if (JSON.stringify(facts[0]) !== JSON.stringify(facts[1]))
    throw new Error("Reserve account sources disagree");
  const [donor, escrow] = facts[0];
  if (BigInt(donor.liquid) < 120000000000000000000000n)
    throw new Error("Fixed demo donor cannot retain its own gas reserve");
  if (BigInt(escrow.liquid) >= 120000000000000000000000n) {
    console.log(
      JSON.stringify({ phase: "already_sufficient", escrowLiquid: escrow.liquid, signed: false }),
    );
    return;
  }
  console.log(
    JSON.stringify({
      phase: "reserve_preflight",
      from: donor.account,
      to: escrow.account,
      amountYoctoNear: "100000000000000000000000",
      internalAllocation: true,
      execute: args.includes("--execute"),
    }),
  );
  if (!args.includes("--execute")) return;
  const journal = await mainnetJournal(name),
    image = signV1IntentsTransaction(
      v1DemoReserveTransaction({
        account: donor.account,
        nonce: (BigInt(donor.nonce) + 1n).toString(),
        blockHash: snapshot.block.hash,
      }),
      await loadV1MainnetKey(),
    );
  await journal.save({ initial: donor, escrowInitial: escrow });
  await journal.submit(
    "reserve",
    { ...image, semantic: "fixed-demo-native-reserve:0.1", validUntilMs: Date.now() + 120000 },
    donor.account,
  );
  await journal.save({ phase: "reserve_final" });
  console.log(
    JSON.stringify({ phase: "reserve_final", hash: image.hash, final: journal.finals.reserve }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Reserve operation refused or its original hash needs reconciliation. No replacement transfer.",
    );
    process.exitCode = 1;
  });
