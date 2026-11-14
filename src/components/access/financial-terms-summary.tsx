import { formatUnits } from "ethers";
import type { ReactNode } from "react";
import { formatUsdc } from "../../domain/event-draft";
import type { ConsentTerms } from "../../server/commitments/consent";
import { manifestHash, networkIdentity, type Network } from "../../server/protocol/manifest";
import { EventTime } from "./event-time";

// Display units only. This metadata grants no route or payment authority.
const nativeCurrency = {
  near: { symbol: "NEAR", decimals: 24 },
  base: { symbol: "ETH", decimals: 18 },
  ethereum: { symbol: "ETH", decimals: 18 },
  solana: { symbol: "SOL", decimals: 9 },
} as const satisfies Record<Network, { symbol: string; decimals: number }>;

export function consentMoneyAmount(value: string, terms: ConsentTerms) {
  const unit =
    terms.environment === "mainnet"
      ? "USDC"
      : terms.environment === "engineering"
        ? "engineering test-token units"
        : "sandbox token units";
  return `${formatUsdc(BigInt(value))} ${unit}`;
}

export function FinancialTermsSummary({ terms }: { terms: ConsentTerms }) {
  const network = networkIdentity(terms.source.network);
  const input =
    terms.environment === "mainnet" &&
    terms.manifest === manifestHash &&
    terms.source.chainId === network.chainId
      ? network.assets.find(
          (asset) =>
            asset.contract === terms.inputAsset.contract &&
            asset.decimals === terms.inputAsset.decimals,
        )
      : undefined;
  const inputUnit =
    input?.id.toUpperCase() ??
    (terms.environment === "mainnet"
      ? "input-token units"
      : `${terms.environment} input-token units`);
  const native = nativeCurrency[terms.source.network];
  const gasUnit =
    terms.environment === "mainnet" ? native.symbol : `${terms.environment} test ${native.symbol}`;
  const deadline = (value: number) => <EventTime instant={value} timeZone={terms.timeZone} />;
  const rows: Array<[string, ReactNode]> = [
    ["Principal", consentMoneyAmount(terms.principal, terms)],
    [
      "Maximum source input",
      `${formatUnits(terms.maximumInput, terms.inputAsset.decimals)} ${inputUnit}`,
    ],
    [
      "Source input asset",
      `${terms.source.network.toUpperCase()} · ${terms.inputAsset.contract} · ${terms.inputAsset.decimals} decimals`,
    ],
    [
      "Maximum source gas cost",
      `${formatUnits(terms.sourceGasMaximum, native.decimals)} ${gasUnit}`,
    ],
    ["Maximum routing fee", consentMoneyAmount(terms.routingFeeMaximum, terms)],
    ["Maximum delivery fee", consentMoneyAmount(terms.withdrawalFeeMaximum, terms)],
    ["Platform fee", consentMoneyAmount("0", terms)],
    ["Minimum net payout", consentMoneyAmount(terms.payoutMinimum, terms)],
    ["Funding wallet", `${terms.source.network}: ${terms.source.address}`],
    ["Source refund destination", `${terms.refund.network}: ${terms.refund.address}`],
    ["Payout destination", `${terms.payout.network}: ${terms.payout.address}`],
    ["Recorded quote expiry", deadline(terms.quoteExpiresAt)],
    ["Recorded reservation expiry limit", deadline(terms.reservationExpiresAt)],
    ["Funding authorization expiry", deadline(terms.authorizationExpiresAt)],
  ];
  return (
    <section aria-label="Original financial limits">
      <h3>Original amounts and fee limits</h3>
      <dl style={{ overflowWrap: "anywhere" }}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
