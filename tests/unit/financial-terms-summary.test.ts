import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { FinancialTermsSummary } from "../../src/components/access/financial-terms-summary";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { networkIdentity, type Network } from "../../src/server/protocol/manifest";
import { consentTerms } from "../fixtures/consent";

test("financial limits preserve input/native precision and keep quote, reservation and approval expiries distinct", () => {
  const cases: Array<{
    network: Network;
    asset: string;
    maximum: string;
    gas: string;
    input: string;
    gasLabel: string;
  }> = [
    {
      network: "near",
      asset: "near",
      maximum: "1000000000000000000000000",
      gas: "250000000000000000000000",
      input: "1.0 NEAR",
      gasLabel: "0.25 NEAR",
    },
    {
      network: "base",
      asset: "eth",
      maximum: "1000000000000000000",
      gas: "100000000000000",
      input: "1.0 ETH",
      gasLabel: "0.0001 ETH",
    },
    {
      network: "ethereum",
      asset: "usdc",
      maximum: "5100000",
      gas: "100000000000000000",
      input: "5.1 USDC",
      gasLabel: "0.1 ETH",
    },
    {
      network: "solana",
      asset: "sol",
      maximum: "1000000000",
      gas: "5000",
      input: "1.0 SOL",
      gasLabel: "0.000005 SOL",
    },
  ];
  for (const item of cases) {
    const address =
      item.network === "near"
        ? "fictional.near"
        : item.network === "solana"
          ? encodeBase58(Buffer.alloc(32, 3))
          : `0x${"12".repeat(20)}`;
    const terms = consentTerms(item.network, address, Date.parse("2026-11-03T18:00:00.000Z"));
    const asset = networkIdentity(item.network).assets.find((asset) => asset.id === item.asset)!;
    terms.inputAsset = { contract: asset.contract, decimals: asset.decimals };
    terms.maximumInput = item.maximum;
    terms.sourceGasMaximum = item.gas;
    terms.authorizationExpiresAt -= 60_000;
    const html = renderToStaticMarkup(createElement(FinancialTermsSummary, { terms }));
    for (const value of [
      item.input,
      item.gasLabel,
      "5.00 USDC",
      "0.10 USDC",
      "0.05 USDC",
      "0.00 USDC",
      "1.00 USDC",
      asset.contract,
      "America/Denver",
    ])
      assert.ok(html.includes(value), `Missing exact recorded limit: ${value}`);
    for (const expiry of [
      terms.quoteExpiresAt,
      terms.reservationExpiresAt,
      terms.authorizationExpiresAt,
    ])
      assert.ok(html.includes(new Date(expiry).toISOString()));
    assert.equal(
      new Set([terms.quoteExpiresAt, terms.reservationExpiresAt, terms.authorizationExpiresAt])
        .size,
      3,
    );
  }
});
