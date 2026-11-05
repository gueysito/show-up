import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { accountFixtures } from "./accounts";
import { verifyNearWallet } from "./near-wallet";
import { validDraft } from "./draft";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { prepareV1Registration } from "../../src/server/commitments/v1-registration";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Registration } from "../../src/worker/v1-registration";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { v1Deployment, readV1Snapshot, type V1Snapshot } from "../../src/server/protocol/v1-escrow";
import { validateV1Action, observeV1Action } from "../../src/worker/v1-action-observation";
import type { V1ActionGateway } from "../../src/worker/v1-actions";
import type { V1ActionImage } from "../../src/server/events/v1-actions";

export async function v1EventFixture() {
  const f = await accountFixtures([["host"], [], ["host"]]),
    key = randomBytes(32).toString("hex"),
    config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: key,
      SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
    })!;
  const sessions = f.accounts.map((a) => hash(a.value)),
    eventId = randomUUID(),
    signer = nativeKey(randomBytes(32)),
    block = encodeBase58(Buffer.alloc(32, 9)),
    start = Date.now() + 4000;
  let event: Record<string, unknown> | null = null,
    height = 100;
  const registrations = new Map<string, Record<string, unknown>>(),
    claims = new Map<string, Record<string, unknown>>();
  const transport: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)),
      p = input.params,
      result =
        input.method === "status"
          ? { chain_id: "mainnet" }
          : input.method === "block"
            ? {
                header: {
                  height,
                  hash: block,
                  timestamp_nanosec: (BigInt(Date.now()) * 1000000n).toString(),
                },
              }
            : {
                block_height: height,
                block_hash: block,
                ...(p.request_type === "view_account"
                  ? { code_hash: v1Deployment.codeHash }
                  : p.request_type === "view_access_key_list"
                    ? {
                        keys: [
                          {
                            public_key: signer.publicKey,
                            access_key: { permission: "FullAccess" },
                          },
                        ],
                      }
                    : {
                        result: [
                          ...Buffer.from(
                            JSON.stringify(
                              p.method_name === "get_event"
                                ? event
                                : p.method_name === "get_registration"
                                  ? (registrations.get(
                                      JSON.parse(Buffer.from(p.args_base64, "base64").toString())
                                        .registration,
                                    ) ?? null)
                                  : p.method_name === "get_claim"
                                    ? (claims.get(
                                        JSON.parse(Buffer.from(p.args_base64, "base64").toString())
                                          .claim,
                                      ) ?? null)
                                    : null,
                            ),
                          ),
                        ],
                      }),
              };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  // One hash always has one header, even when two calls straddle a millisecond.
  const stableTime = Date.now();
  const stableTransport: typeof fetch = async (url, init) => {
    const response = await transport(url, init),
      v = await response.json();
    if (v.result?.header)
      v.result.header.timestamp_nanosec = (BigInt(stableTime) * 1000000n).toString();
    return Response.json(v);
  };
  const snapshot = () =>
    ({
      block: { hash: block, height: String(height), timestampMs: stableTime },
      event,
    }) as V1Snapshot;
  const signed = (semantic: string) => ({
    hash: block,
    signedBase64: "isolated-test-only",
    semantic,
    validUntilMs: Date.now() + 120000,
  });
  try {
    const wallets = [];
    for (let index = 1; index <= 2; index++)
      wallets.push(
        await verifyNearWallet(
          f.pool,
          config,
          sessions[index],
          { address: `attendee-${index}.near`, ...signer },
          stableTransport,
        ),
      );
    await saveAccountDraft(
      f.pool,
      key,
      sessions[0],
      {
        id: eventId,
        operationId: randomUUID(),
        revision: 0,
        data: {
          ...validDraft(),
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 30 * 60000).toISOString(),
          capacity: 2,
          commitment: "1",
          sponsorBudget: "0",
          access: "open",
        },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, sessions[0], randomUUID(), eventId, 1);
    await runV1Publication(f.pool, key, {
      async prepare(image) {
        event = {
          ...image.terms,
          status: "published",
          funded: [],
          winner: null,
          prize_received: true,
        };
        return signed(canonicalHash(image.terms));
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async snapshot() {
        return snapshot();
      },
    });
    const rules = (await f.pool.query("SELECT rules_hash FROM app_events WHERE id=$1", [eventId]))
      .rows[0].rules_hash;
    const ids: string[] = [];
    for (let index = 1; index <= 2; index++) {
      const reg = await prepareV1Registration(
        f.pool,
        config,
        sessions[index],
        randomUUID(),
        eventId,
        rules,
        wallets[index - 1].id,
        stableTransport,
      );
      ids.push(reg.registrationId);
      await runV1Registration(f.pool, key, {
        async prepare(image) {
          registrations.set(image.id, {
            id: image.id,
            event: eventId,
            sender: image.sender,
            payout: image.payout,
            ethereum: null,
            funded: true,
            attended: false,
          });
          (event!.funded as string[]).push(image.id);
          return signed(canonicalHash(image));
        },
        async submit() {},
        async final() {
          return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
        },
        async observe(image) {
          return { snapshot: snapshot(), registration: registrations.get(image.id)! };
        },
      });
    }
    await pause(Math.max(0, start - Date.now() + 20));
    // Keep this event inside the live window without changing the frozen terms.
    let liveTime = Date.now();
    const liveTransport: typeof fetch = async (url, init) => {
      const response = await stableTransport(url, init),
        v = await response.json();
      if (v.result?.header)
        v.result.header.timestamp_nanosec = (BigInt(liveTime) * 1000000n).toString();
      return Response.json(v);
    };
    const images = new Map<string, V1ActionImage>();
    let sends = 0,
      unknown = false,
      failedTransfer = false;
    const gateway: V1ActionGateway = {
      async prepare(image) {
        await validateV1Action(image, await readV1Snapshot(eventId, liveTransport), liveTransport);
        const s = signed(canonicalHash(image));
        s.hash = encodeBase58(Buffer.from(image.id.replaceAll("-", ""), "hex"));
        images.set(s.hash, image);
        return s;
      },
      async submit(signed) {
        sends++;
        const image = images.get(signed.hash)!;
        if (image.kind === "check_in") registrations.get(image.target)!.attended = true;
        else if (image.kind === "settle") {
          event!.status = "settled";
          event!.winner = ids[0];
          claims.set(ids[0], {
            recipient: registrations.get(ids[0])!.payout,
            remaining: "2000000",
            paid: "0",
            pending: false,
            in_flight: "0",
          });
        } else if (image.kind === "cancel") {
          event!.status = "cancelled";
          for (const id of ids)
            claims.set(id, {
              recipient: registrations.get(id)!.payout,
              remaining: "1000000",
              paid: "0",
              pending: false,
              in_flight: "0",
            });
        } else if (!failedTransfer) {
          const claim = claims.get(image.target)!;
          claim.paid = (BigInt(String(claim.paid)) + BigInt(String(claim.remaining))).toString();
          claim.remaining = "0";
        }
        if (unknown) {
          unknown = false;
          throw new Error("Unknown acknowledgement");
        }
      },
      async final() {
        return { success: true, minimumHeight: String(height), gasYoctoNear: "1" };
      },
      async observe(image, minimumHeight) {
        return observeV1Action(
          image,
          await readV1Snapshot(eventId, liveTransport),
          minimumHeight,
          liveTransport,
        );
      },
    };
    return {
      ...f,
      key,
      config,
      eventId,
      sessions,
      ids,
      registrations,
      claims,
      transport: liveTransport,
      gateway,
      sends: () => sends,
      loseNextAck: () => {
        unknown = true;
      },
      failTransfer: (value: boolean) => {
        failedTransfer = value;
      },
      setHeight: (value: number) => {
        height = value;
      },
      end: () => {
        liveTime = Number(event!.end_ms) + 1;
        return liveTime;
      },
      event: () => event!,
    };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}
