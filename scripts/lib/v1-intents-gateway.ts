import { V1ReadOnlyRpc } from "../../src/server/protocol/v1-rpc";
import { readV1Snapshot, readV1Record, v1Deployment } from "../../src/server/protocol/v1-escrow";
import {
  v1Intents,
  readV1RouteAccount,
  readV1IntentsBalance,
} from "../../src/server/protocol/v1-intents";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { record } from "../../src/server/protocol/quote-signature";
import { unsigned } from "../../src/server/protocol/rpc";
import { matchesV1Registration } from "../../src/server/commitments/v1-registration";
import { v1Claim } from "../../src/server/events/v1-actions";
import type { V1IntentsGateway, V1IntentsWithdrawal } from "../../src/worker/v1-intents";
import type { V1RegistrationImage } from "../../src/server/commitments/v1-registration";
import {
  v1IntentsAccountTransaction,
  v1SponsoredIntentsWithdrawal,
  signV1IntentsTransaction,
} from "./native-engineering-transaction";
import { loadV1MainnetKey } from "./v1-mainnet-key";
import type { SignedV1Publication } from "../../src/worker/v1-publication";

export function v1IntentsGateway(
  kind: "route_account" | "route_withdrawal",
  native: {
    submit(signed: SignedV1Publication): Promise<void>;
    final(
      signed: SignedV1Publication,
      sender: string,
    ): Promise<{ success: boolean; minimumHeight: string; gasYoctoNear: string }>;
  },
  transport?: typeof fetch,
): V1IntentsGateway<V1RegistrationImage | V1IntentsWithdrawal> {
  return {
    submit: (signed) => native.submit(signed),
    final: (signed) =>
      native.final(signed, kind === "route_account" ? v1Deployment.account : v1Deployment.owner),
    async prepare(image) {
      const registration =
          image.format === "showup.v1.registration.v1" ? image : image.registration,
        snapshot = await readV1Snapshot(registration.eventId, transport),
        rpc = new V1ReadOnlyRpc("near-fastnear", transport),
        protocol = record(
          await rpc.read("EXPERIMENTAL_protocol_config", { block_id: snapshot.block.hash }),
        );
      if (
        !registration.source ||
        registration.sender !== v1Intents.account ||
        protocol.chain_id !== "mainnet" ||
        protocol.protocol_version !== v1Deployment.protocolVersion ||
        unsigned(record(protocol.runtime_config).min_gas_purchase_price) > 1000000000n ||
        unsigned(record(protocol.runtime_config).storage_amount_per_byte) !== 10000000000000000000n
      )
        throw new Error("Intents native execution profile changed");
      let transaction: ReturnType<typeof v1IntentsAccountTransaction>;
      let key: Awaited<ReturnType<typeof loadV1MainnetKey>>;
      if (kind === "route_account") {
        if (image.format !== "showup.v1.registration.v1")
          throw new Error("Wrong route account image");
        if (await readV1RouteAccount(image.id, snapshot, transport))
          throw new Error("Route account already exists; reconcile original creation");
        const facts = await Promise.all(
          ["near-fastnear", "near-drpc"].map(async (endpoint) => {
            const source = new V1ReadOnlyRpc(endpoint, transport),
              params = { account_id: v1Deployment.account, block_id: snapshot.block.hash },
              [account, list] = await Promise.all([
                source.read("query", { ...params, request_type: "view_account" }),
                source.read("query", { ...params, request_type: "view_access_key_list" }),
              ]),
              keys = record(list).keys;
            for (const value of [account, list])
              if (
                record(value).block_hash !== snapshot.block.hash ||
                String(record(value).block_height) !== snapshot.block.height
              )
                throw new Error("Intents account sponsor block mismatch");
            if (
              record(account).code_hash !== v1Deployment.codeHash ||
              !Array.isArray(keys) ||
              keys.length !== 1 ||
              record(keys[0]).public_key !== v1Deployment.publicKey ||
              record(record(keys[0]).access_key).permission !== "FullAccess"
            )
              throw new Error("Intents account sponsor authority changed");
            const liquid =
              unsigned(record(account).amount, 128) -
              unsigned(record(account).storage_usage, 64) * 10000000000000000000n;
            if (liquid < BigInt(v1Intents.accountFunding) + 20000000000000000000000n)
              throw new Error(
                "Escrow needs its existing native gas reserve replenished before route account creation",
              );
            return unsigned(record(record(keys[0]).access_key).nonce, 64).toString();
          }),
        );
        if (facts[0] !== facts[1]) throw new Error("Route sponsor nonce disagreement");
        key = await loadV1MainnetKey();
        transaction = v1IntentsAccountTransaction({
          registrationId: image.id,
          nonce: (BigInt(facts[0]) + 1n).toString(),
          blockHash: snapshot.block.hash,
        });
      } else {
        if (
          image.format !== "showup.v1.intents-withdrawal.v1" ||
          BigInt(snapshot.block.height) < BigInt(image.minimumHeight)
        )
          throw new Error("Wrong Intents withdrawal context");
        const [account, balance, reg] = await Promise.all([
          readV1RouteAccount(registration.id, snapshot, transport),
          readV1IntentsBalance(registration.id, snapshot, transport),
          readV1Record("get_registration", registration.id, snapshot.block, transport),
        ]);
        if (
          !account ||
          BigInt(account.liquid) < 12000000000000000000000n ||
          BigInt(balance) < BigInt(image.amount) ||
          !matchesV1Registration(reg, registration)
        )
          throw new Error("Intents withdrawal balance, reserve or registration changed");
        const sponsors = await Promise.all(
          ["near-fastnear", "near-drpc"].map(async (id) => {
            const source = new V1ReadOnlyRpc(id, transport),
              params = { account_id: v1Deployment.owner, block_id: snapshot.block.hash },
              [balance, keys] = await Promise.all([
                source.read("query", { ...params, request_type: "view_account" }),
                source.read("query", { ...params, request_type: "view_access_key_list" }),
              ]),
              list = record(keys).keys;
            for (const result of [balance, keys])
              if (
                record(result).block_hash !== snapshot.block.hash ||
                String(record(result).block_height) !== snapshot.block.height
              )
                throw new Error("Intents gas sponsor block mismatch");
            if (
              record(balance).code_hash !== "1".repeat(32) ||
              !Array.isArray(list) ||
              list.length !== 1 ||
              record(list[0]).public_key !== v1Deployment.publicKey ||
              record(record(list[0]).access_key).permission !== "FullAccess"
            )
              throw new Error("Intents gas sponsor authority changed");
            if (
              unsigned(record(balance).amount, 128) -
                unsigned(record(balance).storage_usage, 64) * 10000000000000000000n <
              120000000000000000000000n
            )
              throw new Error(
                "Controller needs its existing native gas reserve replenished before forwarding",
              );
            return unsigned(record(record(list[0]).access_key).nonce, 64).toString();
          }),
        );
        if (sponsors[0] !== sponsors[1]) throw new Error("Intents gas sponsor nonce disagreement");
        key = await loadV1MainnetKey();
        transaction = v1SponsoredIntentsWithdrawal(
          {
            registrationId: registration.id,
            nonce: (BigInt(sponsors[0]) + 1n).toString(),
            senderNonce: (BigInt(account.nonce) + 1n).toString(),
            blockHash: snapshot.block.hash,
            blockHeight: snapshot.block.height,
            amount: image.amount,
          },
          key,
        );
      }
      return {
        ...signV1IntentsTransaction(transaction, key),
        semantic: canonicalHash(image),
        validUntilMs: Date.now() + (kind === "route_account" ? 120000 : 60000),
      };
    },
    async observe(image, minimumHeight) {
      const registration =
          image.format === "showup.v1.registration.v1" ? image : image.registration,
        snapshot = await readV1Snapshot(registration.eventId, transport);
      if (BigInt(snapshot.block.height) < BigInt(minimumHeight))
        throw new Error("Intents source has not reached original receipts");
      if (
        image.format === "showup.v1.intents-withdrawal.v1" &&
        BigInt(snapshot.block.height) < BigInt(image.minimumHeight)
      )
        throw new Error("Intents observation regressed");
      if (kind === "route_account") {
        const account = await readV1RouteAccount(registration.id, snapshot, transport);
        return {
          height: snapshot.block.height,
          confirmed: Boolean(account && BigInt(account.amount) >= BigInt(v1Intents.accountFunding)),
        };
      }
      if (image.format !== "showup.v1.intents-withdrawal.v1")
        throw new Error("Wrong Intents observation image");
      const reg = await readV1Record(
          "get_registration",
          registration.id,
          snapshot.block,
          transport,
        ),
        claim = v1Claim(
          await readV1Record("get_claim", `recovery:${registration.id}`, snapshot.block, transport),
          registration.payout,
        );
      if (!matchesV1Registration(reg, registration))
        throw new Error("Intents observed registration changed");
      return {
        height: snapshot.block.height,
        confirmed:
          (!image.previouslyFunded &&
            reg!.funded === true &&
            image.amount === registration.amount) ||
          BigInt(claim.total) >= BigInt(image.recoveryTotal) + BigInt(image.amount),
      };
    },
  };
}
