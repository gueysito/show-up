import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import { prepareBrowserNearPayment } from "../fixtures/v1-mainnet";
import { hash, seal } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { authConfig } from "../../src/server/auth/config";
import { runV1Publication, type SignedV1Publication } from "../../src/worker/v1-publication";
import { v1PublicationGateway } from "../../scripts/v1-publication-worker";
import { loadV1MainnetKey } from "../../scripts/lib/v1-mainnet-key";
import {
  signV1MainnetTransaction,
  v1PrizeFundingTransaction,
} from "../../scripts/lib/native-engineering-transaction";
import { readV1Snapshot, v1Deployment, v1EventTerms } from "../../src/server/protocol/v1-escrow";
import { ReadOnlyRpc, unsigned } from "../../src/server/protocol/rpc";
import { record } from "../../src/server/protocol/quote-signature";
import { canonicalHash, canonicalJson } from "../../src/server/protocol/canonical";
import { randomUUID } from "node:crypto";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test.setTimeout(300_000);

test("host funds one USDC prize, publishes actual terms and recovers the prize on cancel", async ({
  page,
  context,
}) => {
  if (process.env.SHOWUP_MAINNET_PRIZE !== "1")
    throw new Error("Explicit prize mainnet execution required");
  const directory = "contracts/.cache/v1-browser";
  const attempt = process.env.SHOWUP_MAINNET_PRIZE_ATTEMPT ?? "1";
  if (!/^[1-9][0-9]?$/.test(attempt)) throw new Error("Invalid explicit financial attempt");
  const path = `${directory}/prize-publication${attempt === "1" ? "" : `-${attempt}`}.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let journal: Record<string, unknown> = {
    phase: "started",
    authentication:
      "preauthenticated engineering host; owner-controlled wallet approval in isolated Node process",
  };
  const resume = process.env.SHOWUP_MAINNET_PRIZE_RESUME === "1";
  if (resume) {
    journal = JSON.parse(await readFile(path, "utf8"));
    expect(journal.phase).toBe("create_submitted");
    expect(Object.keys(journal.images as object)).toEqual(["create"]);
  } else await writeFile(path, JSON.stringify(journal) + "\n", { mode: 0o600, flag: "wx" });
  async function save(update: Record<string, unknown>) {
    journal = { ...journal, ...update };
    await writeFile(`${path}.next`, JSON.stringify(journal) + "\n", { mode: 0o600 });
    await rename(`${path}.next`, path);
  }
  const f = await accountFixtures([["host"]]),
    key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!;
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: key,
    SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
  })!;
  const native = v1PublicationGateway();
  const images: Record<string, SignedV1Publication> =
      (journal.images as Record<string, SignedV1Publication>) ?? {},
    finals: Record<string, unknown> = {};
  let eventId: string | undefined,
    funded = false,
    refunded = false;
  async function reconcile(image: SignedV1Publication) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await native.final(image);
        expect(result.success).toBe(true);
        return result;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    throw new Error("Original transaction needs reconciliation");
  }
  async function ownerNonce(block: string) {
    const nonces = await Promise.all(
      ["near-fastnear", "near-drpc"].map(async (id) => {
        const result = record(
          await new ReadOnlyRpc(id).read("query", {
            request_type: "view_access_key",
            account_id: v1Deployment.owner,
            public_key: v1Deployment.publicKey,
            block_id: block,
          }),
        );
        if (result.block_hash !== block || result.permission !== "FullAccess")
          throw new Error("Owner key changed");
        return unsigned(result.nonce, 64).toString();
      }),
    );
    expect(nonces[0]).toBe(nonces[1]);
    return (BigInt(nonces[0]) + 1n).toString();
  }
  async function balances(block: string) {
    const values = await Promise.all(
      ["near-fastnear", "near-drpc"].map(async (id) => {
        const client = new ReadOnlyRpc(id);
        return Promise.all(
          [v1Deployment.owner, v1Deployment.account].map(async (account_id) => {
            const result = record(
              await client.read("query", {
                request_type: "call_function",
                account_id: v1Deployment.token,
                method_name: "ft_balance_of",
                args_base64: Buffer.from(canonicalJson({ account_id })).toString("base64"),
                block_id: block,
              }),
            );
            expect(result.block_hash).toBe(block);
            return JSON.parse(Buffer.from(result.result as number[]).toString("utf8")) as string;
          }),
        );
      }),
    );
    expect(values[0]).toEqual(values[1]);
    return values[0];
  }
  async function refund() {
    const snapshot = await readV1Snapshot(eventId!);
    if (snapshot.event?.prize_received !== true) return;
    const signer = await loadV1MainnetKey();
    const tx = signV1MainnetTransaction(
      {
        signer: v1Deployment.owner,
        receiver: v1Deployment.account,
        nonce: await ownerNonce(snapshot.block.hash),
        blockHash: snapshot.block.hash,
        actions: [
          {
            kind: "call",
            method: "cancel",
            args: Buffer.from(canonicalJson({ event: eventId })),
            gas: "30000000000000",
            deposit: "0",
          },
          {
            kind: "call",
            method: "withdraw",
            args: Buffer.from(canonicalJson({ claim: `prize:${eventId}` })),
            gas: "100000000000000",
            deposit: "0",
          },
        ],
      },
      signer,
    );
    const image = {
      ...tx,
      semantic: "cancel-and-return-fixed-sponsor-prize",
      validUntilMs: Date.now() + 120000,
    };
    images.refund = image;
    await save({ phase: "refund_submitted", images });
    await native.submit(image);
    finals.refund = await reconcile(image);
    refunded = true;
    const after = await readV1Snapshot(eventId!);
    const amounts = await balances(after.block.hash);
    expect(amounts).toEqual(journal.initialUsdc);
    await save({
      phase: "refunded",
      images,
      finals,
      finalUsdc: amounts,
      finalEvent: after.event,
      finalHeight: after.block.height,
    });
  }
  try {
    if (Number(attempt) > 1 && !resume) {
      const priorPath = `${directory}/prize-publication${attempt === "2" ? "" : `-${Number(attempt) - 1}`}.json`;
      const prior = JSON.parse(await readFile(priorPath, "utf8"));
      expect(prior.phase).toBe("refunded");
      expect(prior.finalUsdc).toEqual(prior.initialUsdc);
      expect((await readV1Snapshot(prior.eventId)).event?.status).toBe("cancelled");
      await reconcile(prior.images.refund);
    }
    // Control-proof service verifies this public key against live mainnet sources.
    const signer = await loadV1MainnetKey();
    const wallet = await verifyNearWallet(f.pool, config, hash(f.accounts[0].value), {
      address: v1Deployment.owner,
      ...signer,
    });
    await f.enter(context, 0);
    const draft = validDraft(),
      title = resume
        ? String(journal.title)
        : `Mainnet prize publication ${new Date().toISOString().slice(0, 16)}`;
    if (resume) {
      eventId = String(journal.eventId);
      const original = await readV1Snapshot(eventId);
      expect(original.event?.status).toBe("draft");
      expect(original.event?.prize_received).toBe(false);
      expect(canonicalHash(v1EventTerms(original.event!))).toBe(images.create.semantic);
      expect((await reconcile(images.create))!.success).toBe(true);
      await saveAccountDraft(
        f.pool,
        key,
        hash(f.accounts[0].value),
        {
          id: eventId,
          revision: 0,
          operationId: randomUUID(),
          data: {
            ...draft,
            title,
            sessionReference: "https://example.com/showup-prize-verification",
            capacity: 2,
            commitment: "1",
            sponsorBudget: "1",
            access: "open",
            startsAt: new Date(original.event!.start_ms as number).toISOString(),
            endsAt: new Date(original.event!.end_ms as number).toISOString(),
          },
        },
        "v1",
      );
      await prepareV1Publication(
        f.pool,
        key,
        hash(f.accounts[0].value),
        randomUUID(),
        eventId,
        1,
        wallet.id,
      );
      await f.pool.query(
        "UPDATE app_publication_images SET transaction_state='submitted',transaction_hash=$2,encrypted_transaction=$3 WHERE event_id=$1",
        [
          eventId,
          images.create.hash,
          seal(key, `v1-publication-transaction:${eventId}`, images.create),
        ],
      );
      await page.goto(`/host?event=${eventId}`);
      await expect(page.getByLabel("Event name", { exact: true })).toHaveValue(title);
    } else {
      await page.goto("/host");
      await page.getByLabel("Event name", { exact: true }).fill(title);
      await page
        .getByLabel("Session URL", { exact: true })
        .fill("https://example.com/showup-prize-verification");
      await page.getByLabel("Planned start", { exact: true }).fill(draft.startsAt.slice(0, 16));
      await page.getByLabel("Planned end", { exact: true }).fill(draft.endsAt.slice(0, 16));
      await page.getByLabel("Capacity", { exact: true }).fill("2");
      await page.getByLabel("Registration access", { exact: true }).selectOption("open");
      await page.getByLabel("Planned sponsor budget (USDC)", { exact: true }).fill("1");
      await page.getByRole("button", { name: "Validate & save draft" }).click();
      await expect(page.getByRole("status")).toContainText("Saved private draft");
      await page.getByRole("button", { name: "Close saved details" }).click();
      await expect(page.getByLabel("Prize funding wallet (USDC on NEAR)")).toHaveValue(/.+/);
      await page.getByRole("button", { name: "Create prize event escrow" }).click();
      await expect(page.getByRole("heading", { name: "Publication in progress" })).toBeVisible();
      eventId = (
        await f.pool.query("SELECT id FROM app_events WHERE owner_id=$1", [f.accounts[0].id])
      ).rows[0].id;
      const initial = await readV1Snapshot(eventId!);
      await save({
        phase: "requested",
        eventId,
        title,
        initialUsdc: await balances(initial.block.hash),
      });
    }
    const gateway = {
      ...native,
      async submit(image: SignedV1Publication) {
        images[image.phase!] = image;
        await save({ phase: `${image.phase}_submitted`, images });
        await native.submit(image);
      },
    };
    async function worker() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await runV1Publication(f.pool, key, gateway);
        } catch (error) {
          const row = (
            await f.pool.query(
              "SELECT transaction_state FROM app_publication_images WHERE event_id=$1",
              [eventId],
            )
          ).rows[0];
          if (row.transaction_state !== "submitted" || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      throw new Error("Original worker phase needs reconciliation");
    }
    const created = await worker();
    expect(created.state).toBe("awaiting_prize");
    finals.create = created;
    await page.getByRole("button", { name: "Check publication status" }).click();
    const button = page.getByRole("button", { name: "NEAR Mobile", exact: true });
    const unsignedBase64 = await prepareBrowserNearPayment(page, button, "fund-prize");
    const callback = `${config.origin}/host?event=${eventId}`;
    expect(unsignedBase64.length).toBeGreaterThan(0);
    const fresh = await readV1Snapshot(eventId!);
    const image = v1PrizeFundingTransaction({
      signer: v1Deployment.owner,
      publicKey: signer.publicKey,
      nonce: await ownerNonce(fresh.block.hash),
      blockHash: fresh.block.hash,
      eventId: eventId!,
      amount: "1000000",
    });
    // Wallets may refresh nonce/block hash. Independently validate the requested
    // immutable transaction bytes before approving this exact one with our key.
    const requested = Buffer.from(unsignedBase64, "base64");
    const nonceOffset = 4 + Buffer.byteLength(v1Deployment.owner) + 33;
    const requestedNonce = requested.readBigUInt64LE(nonceOffset).toString();
    // The server response's hash binds the full unsigned bytes; the constructor's
    // fixed actions below must match after replacing only nonce/block fields.
    const normalized = Buffer.from(requested);
    image.bytes.copy(normalized, nonceOffset, nonceOffset, nonceOffset + 8);
    const blockOffset = nonceOffset + 8 + 4 + Buffer.byteLength(v1Deployment.token);
    image.bytes.copy(normalized, blockOffset, blockOffset, blockOffset + 32);
    expect(normalized.equals(image.bytes)).toBe(true);
    expect(BigInt(requestedNonce) > 0n).toBe(true);
    const signed = {
      hash: image.hash,
      signedBase64: Buffer.concat([
        image.bytes,
        Buffer.from([0]),
        signer.sign(image.digest),
      ]).toString("base64"),
      semantic: `prize:${eventId}:1000000`,
      validUntilMs: Date.now() + 120000,
    };
    images.funding = signed;
    await save({ phase: "funding_submitted", images });
    await native.submit(signed);
    finals.funding = await reconcile(signed);
    const fundedSnapshot = await readV1Snapshot(eventId!);
    expect(fundedSnapshot.event?.prize_received).toBe(true);
    funded = true;
    await save({ phase: "funded", images, finals, fundedHeight: fundedSnapshot.block.height });
    await page.goto(callback);
    await expect(page.getByLabel("Event name", { exact: true })).toHaveValue(title);
    await expect(page).toHaveURL("https://localhost:3444/host");
    await page.getByRole("button", { name: "Check publication status" }).click();
    await page.getByRole("button", { name: "Confirm prize and publish" }).click();
    await expect(
      page.getByRole("region", { name: "Event publication and access" }).getByRole("status"),
    ).toContainText("Prize receipt confirmed");
    const published = await worker();
    expect(published.state).toBe("verified");
    finals.publish = published;
    await page.getByRole("button", { name: "Check publication status" }).click();
    await expect(page).toHaveURL(new RegExp(`/events/${eventId}$`));
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("region", { name: "Verified mainnet event" })).toBeVisible();
    await expect(
      page.getByText(/One checked-in attendee also receives the funded USDC prize/),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${directory}/prize-publication-mobile.png` });
    await save({
      phase: "browser_verified",
      images,
      finals,
      event: (await readV1Snapshot(eventId!)).event,
    });
    await refund();
  } finally {
    // Preserve every original signed image before cleanup, including on a failed
    // browser assertion. Never construct a replacement for an uncertain send.
    if (funded && !images.refund && !refunded) await refund();
    await f.cleanup();
  }
});
