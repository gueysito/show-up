import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { mainnetJournal, mainnetUsdc, approveMainnetDeposit } from "../fixtures/v1-mainnet";
import { prepareDemoAccounts, fundDemoPrize, restoreDemoUsdc } from "../fixtures/v1-demo";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import { hash } from "../../src/server/auth/crypto";
import { authConfig } from "../../src/server/auth/config";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { confirmV1PrizeFunding } from "../../src/server/events/v1-prize-funding";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Registration } from "../../src/worker/v1-registration";
import { runV1Action } from "../../src/worker/v1-actions";
import {
  v1PublicationGateway,
  v1RegistrationGateway,
  v1ActionGateway,
} from "../../scripts/v1-publication-worker";
import { loadV1MainnetKey } from "../../scripts/lib/v1-mainnet-key";
import { v1DemoAccounts } from "../../scripts/lib/native-engineering-transaction";
import { readV1Snapshot, readV1Record, v1Deployment } from "../../src/server/protocol/v1-escrow";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test.setTimeout(1_200_000);
test("mainnet browser checks in one of two funded attendees, settles the prize and no-show share, then withdraws to the fixed wallet", async ({
  page,
  context,
}) => {
  if (process.env.SHOWUP_MAINNET_SETTLEMENT !== "1")
    throw new Error("Explicit mainnet settlement approval scope required");
  const attempt = Number(process.env.SHOWUP_MAINNET_SETTLEMENT_ATTEMPT ?? "1");
  if (![1, 2].includes(attempt))
    throw new Error("Review retained settlement attempts before another run");
  if (attempt === 2) {
    const prior = JSON.parse(
      await readFile("contracts/.cache/v1-browser/attendee-settlement.json", "utf8"),
    );
    expect(prior.phase).toBe("aborted_preflight");
    expect(Object.keys(prior.images)).toHaveLength(0);
  }
  const journal = await mainnetJournal(
      attempt === 1 ? "attendee-settlement" : "attendee-settlement-verified",
    ),
    eventId = randomUUID();
  await journal.save({
    eventId,
    initialUsdc: ["2549953", "0"],
    demoAccounts: v1DemoAccounts,
    prizeAtomic: "250000",
  });
  await prepareDemoAccounts(journal);
  const f = await accountFixtures([["host"], [], []]),
    key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: key,
      SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
    })!;
  const native = v1PublicationGateway(),
    registrations: string[] = [];
  let restored = false;
  try {
    const signer = await loadV1MainnetKey();
    const sponsor = await verifyNearWallet(f.pool, config, hash(f.accounts[0].value), {
      address: v1Deployment.owner,
      ...signer,
    });
    for (let i = 0; i < 2; i++)
      await verifyNearWallet(f.pool, config, hash(f.accounts[i + 1].value), {
        address: v1DemoAccounts[i],
        ...signer,
      });
    const start = Date.now() + 7 * 60000;
    await saveAccountDraft(
      f.pool,
      key,
      hash(f.accounts[0].value),
      {
        id: eventId,
        operationId: randomUUID(),
        revision: 0,
        data: {
          ...validDraft(),
          title: "Mainnet attendance and settlement",
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 30 * 60000).toISOString(),
          capacity: 2,
          commitment: "1",
          sponsorBudget: "0.25",
          access: "open",
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
      sponsor.id,
    );
    async function publication(name: string) {
      return runV1Publication(f.pool, key, {
        ...native,
        submit: (image) => journal.send(name, image),
        final: (image) => journal.final(name, image),
      });
    }
    expect((await publication("creation")).state).toBe("awaiting_prize");
    await fundDemoPrize(journal, eventId);
    await confirmV1PrizeFunding(f.pool, key, hash(f.accounts[0].value), randomUUID(), eventId, 1);
    expect((await publication("publication")).state).toBe("verified");
    for (let index = 0; index < 2; index++) {
      await f.enter(context, index + 1);
      await page.goto(`/events/${eventId}/commit`);
      const panel = page.getByRole("region", { name: "NEAR USDC deposit" });
      await expect(panel).toBeVisible();
      await panel.getByRole("checkbox").check();
      await panel.getByRole("button", { name: "Prepare my deposit" }).click();
      await expect(panel.getByRole("status")).toContainText("Registration queued");
      const id = (
        await f.pool.query(
          "SELECT id FROM app_v1_registrations WHERE event_id=$1 AND account_id=$2",
          [eventId, f.accounts[index + 1].id],
        )
      ).rows[0].id;
      registrations.push(id);
      await journal.save({ registrations });
      await page.goto("about:blank");
      const gateway = v1RegistrationGateway(),
        name = `registration_${index}`;
      expect(
        (
          await runV1Registration(f.pool, key, {
            ...gateway,
            submit: (image) => journal.send(name, image),
            final: (image) => journal.final(name, image),
          })
        ).state,
      ).toBe("registered");
      await page.goto(`${config.origin}/events/${eventId}/commit`);
      await expect(
        panel.getByRole("button", { name: "Approve USDC deposit in MyNearWallet" }),
      ).toBeVisible();
      let unsigned = "",
        callback = "";
      await page.route("https://app.mynearwallet.com/sign?**", async (route) => {
        const url = new URL(route.request().url());
        unsigned = url.searchParams.get("transactions")!;
        callback = url.searchParams.get("callbackUrl")!;
        await route.fulfill({ contentType: "text/html", body: "Isolated project-wallet approval" });
      });
      await panel.getByRole("button", { name: "Approve USDC deposit in MyNearWallet" }).click();
      await expect(page).toHaveURL(/app\.mynearwallet\.com\/sign/);
      await journal.submit(
        `deposit_${index}`,
        await approveMainnetDeposit(unsigned, eventId, id, "1000000", v1DemoAccounts[index]),
        v1DemoAccounts[index],
      );
      await page.goto(`${callback}?transactionHashes=untrusted`);
      await expect(
        page.getByRole("heading", { name: "Deposit confirmed", exact: true }),
      ).toBeVisible();
      await page.goto("about:blank");
      await page.unroute("https://app.mynearwallet.com/sign?**");
    }
    expect(
      await mainnetUsdc((await readV1Snapshot(eventId)).block.hash, [
        v1Deployment.owner,
        v1Deployment.account,
        ...v1DemoAccounts,
      ]),
    ).toEqual(["299953", "2250000", "0", "0"]);
    await journal.save({ phase: "funded_waiting_for_start", startMs: start });
    while (Date.now() < start + 5000) await pause(Math.min(10000, start + 5000 - Date.now()));
    await f.enter(context, 0);
    await page.goto(`${config.origin}/events/${eventId}/manage`);
    const host = page.getByRole("region", { name: "Host mainnet controls" });
    await host.getByRole("button", { name: "Show a fresh check-in code" }).click();
    const code = await host.getByLabel("Live check-in code").textContent();
    expect(code).toMatch(/^\d{6}$/);
    await f.enter(context, 1);
    await page.goto(`${config.origin}/events/${eventId}/commit`);
    const attendee = page.getByRole("region", { name: "Check-in and receipt" });
    await attendee.getByLabel("Host's six-digit check-in code").fill(code!);
    await attendee.getByRole("button", { name: "Check in", exact: true }).click();
    await expect(attendee.getByRole("status")).toContainText("Request saved");
    await page.goto("about:blank");
    const actionGateway = v1ActionGateway(f.pool, key);
    async function action(name: string) {
      return runV1Action(f.pool, key, {
        ...actionGateway,
        submit: (image) => journal.send(name, image),
        final: (image) => journal.final(name, image),
      });
    }
    expect((await action("check_in")).state).toBe("verified");
    await page.goto(`${config.origin}/events/${eventId}/commit`);
    await expect(
      attendee.getByText("Checked in · confirmed by the contract", { exact: true }),
    ).toBeVisible();
    await f.enter(context, 0);
    await page.goto(`${config.origin}/events/${eventId}/manage`);
    await expect(host.getByText(/Attendee .*Checked in/)).toBeVisible();
    await host.getByRole("checkbox").check();
    await host.getByRole("button", { name: "Close and settle event" }).click();
    await expect(host.getByRole("status")).toContainText("Request saved");
    await page.goto("about:blank");
    expect((await action("settle")).state).toBe("verified");
    const settled = await readV1Snapshot(eventId);
    expect(settled.event?.winner).toBe(registrations[0]);
    const claim = await readV1Record("get_claim", registrations[0], settled.block);
    expect(claim?.remaining).toBe("2250000");
    expect(claim?.recipient).toBe(v1DemoAccounts[0]);
    expect(await readV1Record("get_claim", registrations[1], settled.block)).toBe(null);
    await journal.save({ phase: "settled", claim, settlementHeight: settled.block.height });
    await f.enter(context, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${config.origin}/events/${eventId}/commit`);
    await expect(attendee.getByRole("heading", { name: "You won the draw" })).toBeVisible();
    await expect(attendee.getByText("0.25 USDC", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${journal.directory}/attendee-settlement-mobile.png` });
    await attendee.getByRole("button", { name: "Withdraw USDC to my NEAR wallet" }).click();
    await expect(attendee.getByRole("status")).toContainText("Request saved");
    await page.goto("about:blank");
    expect((await action("withdraw")).state).toBe("verified");
    await page.goto(`${config.origin}/events/${eventId}/commit`);
    await expect(
      attendee.getByText("USDC paid: 2.25. Ready to withdraw: 0.00.", { exact: true }),
    ).toBeVisible();
    await page.goto("about:blank");
    await restoreDemoUsdc(journal, eventId);
    restored = true;
  } finally {
    await page.goto("about:blank");
    // A display assertion must not strand already-paid project test funds.
    // Unknown writes still require original-hash reconciliation before any move.
    if (!restored && journal.finals.withdraw && !journal.images.restore_0) {
      try {
        const source = await readV1Snapshot(eventId),
          claim = await readV1Record("get_claim", registrations[0], source.block);
        if (
          claim?.recipient === v1DemoAccounts[0] &&
          claim.paid === "2250000" &&
          claim.remaining === "0" &&
          claim.pending === false
        ) {
          await restoreDemoUsdc(journal, eventId);
          restored = true;
        }
      } catch {
        /* Retain the original journal for explicit reconciliation. */
      }
    }
    if (restored) await f.cleanup();
    else {
      await journal.save({ phase: "needs_original_hash_reconciliation", registrations });
      await f.pool.end();
    }
  }
});
