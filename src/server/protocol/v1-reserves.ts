import { canonicalJson } from "./canonical";
import { compareFinalizedHeads } from "./finalized-heads";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";
import { v1Deployment } from "./v1-escrow";
import { v1Intents } from "./v1-intents";
import { V1ReadOnlyRpc } from "./v1-rpc";

export const v1StorageCostPerByte = 10_000_000_000_000_000_000n;
export const v1RouteAccountFloor =
  BigInt(v1Intents.accountFunding) + 20_000_000_000_000_000_000_000n;
export const v1ControllerSigningFloor = 200_000_000_000_000_000_000_000n;
// Budget 20 new registrations at 0.035 NEAR for route funding, creation fees and storage,
// and 0.01 NEAR for controller fees, in addition to the minimum balances.
const pilotRegistrations = 20n;
export const v1PilotReserveTarget = {
  escrow: v1RouteAccountFloor + pilotRegistrations * 35_000_000_000_000_000_000_000n,
  controller: v1ControllerSigningFloor + pilotRegistrations * 10_000_000_000_000_000_000_000n,
};

export async function readV1Reserves(transport?: typeof fetch) {
  const sources = [
    new V1ReadOnlyRpc("near-fastnear", transport),
    new V1ReadOnlyRpc("near-drpc", transport),
  ] as const;
  const signal = AbortSignal.timeout(12_000);
  const { block } = await compareFinalizedHeads("near", ...sources, Date.now(), signal);
  const observations = await Promise.all(
    sources.map(async (source) => {
      const accounts = await Promise.all(
        [v1Deployment.account, v1Deployment.owner].map(async (accountId) => {
          const account = record(
            await source.read(
              "query",
              { request_type: "view_account", account_id: accountId, block_id: block.hash },
              signal,
            ),
          );
          if (
            account.block_hash !== block.hash ||
            unsigned(account.block_height, 64).toString() !== block.height
          )
            throw new Error("V1 reserve observation block mismatch");
          return {
            amount: unsigned(account.amount, 128).toString(),
            storage: unsigned(account.storage_usage, 64).toString(),
          };
        }),
      );
      return accounts;
    }),
  );
  if (canonicalJson(observations[0]) !== canonicalJson(observations[1]))
    throw new Error("V1 reserve sources disagree");
  const [escrow, controller] = observations[0];
  return {
    escrow: BigInt(escrow.amount) - BigInt(escrow.storage) * v1StorageCostPerByte,
    controller: BigInt(controller.amount),
  };
}
