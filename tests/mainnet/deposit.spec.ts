import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import {
  mainnetJournal,
  mainnetUsdc,
  approveMainnetDeposit,
  ownerMainnetCalls,
  prepareBrowserNearPayment,
} from "../fixtures/v1-mainnet";
import { hash } from "../../src/server/auth/crypto";
import { authConfig } from "../../src/server/auth/config";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Registration } from "../../src/worker/v1-registration";
import { v1PublicationGateway, v1RegistrationGateway } from "../../scripts/v1-publication-worker";
import { loadV1MainnetKey } from "../../scripts/lib/v1-mainnet-key";
import { readV1Snapshot, readV1Record, v1Deployment } from "../../src/server/protocol/v1-escrow";
import { canonicalJson } from "../../src/server/protocol/canonical";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test.setTimeout(300000);
test("attendee reviews and funds a real native-USDC seat through the browser, then receives its cancellation refund", async ({
  page,
  context,
}) => {
  if (process.env.SHOWUP_MAINNET_DEPOSIT !== "1")
    throw new Error("Explicit mainnet deposit execution required");
  const journals = ["attendee-deposit", "attendee-deposit-verified", "attendee-deposit-paced"];
  const attempt = Number(process.env.SHOWUP_MAINNET_DEPOSIT_ATTEMPT ?? "1");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > journals.length)
    throw new Error("Review the retained financial attempts before continuing");
  for (const name of journals.slice(0, attempt - 1)) {
    const prior = JSON.parse(await readFile(`contracts/.cache/v1-browser/${name}.json`, "utf8"));
    expect(prior.phase).toBe("refunded");
    expect(prior.finalUsdc).toEqual(prior.initialUsdc);
    expect((await readV1Snapshot(prior.eventId)).event?.status).toBe("cancelled");
  }
  const journal = await mainnetJournal(journals[attempt - 1]),
    f = await accountFixtures([["host"], []]);
  const key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: key,
      SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
    })!;
  const eventId = randomUUID(),
    native = v1PublicationGateway();
  let registrationId: string | undefined,
    received = false;
  async function refund() {
    const image = await ownerMainnetCalls(eventId, [
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
        args: Buffer.from(canonicalJson({ claim: registrationId })),
        gas: "100000000000000",
        deposit: "0",
      },
    ]);
    await journal.submit("refund", image);
    const after = await readV1Snapshot(eventId),
      claim = await readV1Record("get_claim", registrationId!, after.block);
    expect(claim?.remaining).toBe("0");
    expect(claim?.paid).toBe("1000000");
    expect(claim?.recipient).toBe(v1Deployment.owner);
    const amounts = await mainnetUsdc(after.block.hash);
    expect(amounts).toEqual(["2549953", "0"]);
    await journal.save({
      phase: "refunded",
      finalUsdc: amounts,
      finalHeight: after.block.height,
      claim,
    });
  }
  try {
    const signer = await loadV1MainnetKey();
    await verifyNearWallet(f.pool, config, hash(f.accounts[1].value), {
      address: v1Deployment.owner,
      ...signer,
    });
    await saveAccountDraft(
      f.pool,
      key,
      hash(f.accounts[0].value),
      {
        id: eventId,
        revision: 0,
        operationId: randomUUID(),
        data: {
          ...validDraft(),
          title: `Mainnet attendee deposit ${new Date().toISOString().slice(0, 16)}`,
          capacity: 2,
          commitment: "1",
          sponsorBudget: "0",
          access: "open",
        },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, hash(f.accounts[0].value), randomUUID(), eventId, 1);
    await journal.save({
      eventId,
      initialUsdc: await mainnetUsdc((await readV1Snapshot(eventId)).block.hash),
    });
    expect(
      (
        await runV1Publication(f.pool, key, {
          ...native,
          async submit(image) {
            await journal.send("publication", image);
          },
          async final(image) {
            const result = await native.final(image);
            journal.finals.publication = result;
            await journal.save({ phase: "publication_final" });
            return result;
          },
        })
      ).state,
    ).toBe("verified");
    await f.enter(context, 1);
    await page.goto(`/events/${eventId}`);
    await page.getByRole("link", { name: "Deposit USDC on NEAR", exact: true }).click();
    const panel = page.getByRole("region", { name: "NEAR USDC deposit" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("0 USDC, direct NEAR transfer", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Prepare my deposit" })).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Prepare my deposit" }).click();
    await expect(panel.getByRole("status")).toContainText("Registration queued");
    registrationId = (
      await f.pool.query(
        "SELECT id FROM app_v1_registrations WHERE event_id=$1 AND account_id=$2",
        [eventId, f.accounts[1].id],
      )
    ).rows[0].id;
    await journal.save({ registrationId });
    const gateway = v1RegistrationGateway();
    expect(
      (
        await runV1Registration(f.pool, key, {
          ...gateway,
          async submit(image) {
            await journal.send("registration", image);
          },
          async final(image) {
            const result = await gateway.final(image);
            journal.finals.registration = result;
            await journal.save({ phase: "registration_final" });
            return result;
          },
        })
      ).state,
    ).toBe("registered");
    await panel.getByRole("button", { name: "Check deposit status" }).click();
    const button = panel.getByRole("button", { name: "NEAR Mobile", exact: true });
    const unsigned = await prepareBrowserNearPayment(page, button, "pay");
    const callback = `${config.origin}/events/${eventId}/commit`;
    await journal.submit(
      "deposit",
      await approveMainnetDeposit(unsigned, eventId, registrationId!, "1000000"),
    );
    const funded = await readV1Snapshot(eventId),
      record = await readV1Record("get_registration", registrationId!, funded.block);
    expect(record?.funded).toBe(true);
    received = true;
    await page.goto(`${callback}?transactionHashes=untrusted`);
    await expect(page).toHaveURL(callback);
    await expect(
      page.getByRole("heading", { name: "Deposit confirmed", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Your seat is funded. Do not send another deposit.", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await page.request.post("/api/commitments/mainnet", {
          headers: { origin: config.origin },
          data: { operation: "confirm", operationId: randomUUID(), eventId, funded: true },
        })
      ).status(),
    ).toBe(400);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${journal.directory}/attendee-deposit-mobile.png` });
    await journal.save({
      phase: "browser_verified",
      registration: record,
      height: funded.block.height,
    });
    await refund();
  } finally {
    if (received && !journal.images.refund) await refund();
    await f.cleanup();
  }
});
