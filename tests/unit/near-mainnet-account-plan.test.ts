import assert from "node:assert/strict";
import test from "node:test";
import protocol from "../fixtures/near-mainnet-account-budget.json" with { type: "json" };
import {
  accountRegistrationBudget,
  controllerFunding,
  mainnetAccount,
} from "../../scripts/near-mainnet-account-plan";

test("registration reserves gas at purchase price and blocks a changed policy or excess fee", () => {
  const header = { gas_price: "100000000" };
  const result = accountRegistrationBudget(protocol, header);
  assert.equal(result.minimumGasPurchasePrice, "1000000000");
  assert.equal(result.accountCreationCharge, "7000000000000000000000");
  assert.equal(result.gasPurchaseUpper, "101202558634721000000000");
  const expensive = structuredClone(protocol);
  expensive.runtime_config.transaction_costs.action_creation_config.function_call_cost.execution = 2000000000000;
  assert.throws(() => accountRegistrationBudget(expensive, header), /cap/);
  for (const change of [
    { chain_id: "testnet" },
    { protocol_version: 88 },
    { runtime_config: { ...protocol.runtime_config, min_gas_purchase_price: "1000000001" } },
    {
      runtime_config: {
        ...protocol.runtime_config,
        account_creation_charge: "8000000000000000000000",
      },
    },
  ])
    assert.throws(() => accountRegistrationBudget({ ...protocol, ...change }, header), /policy/);
  assert.throws(() => accountRegistrationBudget(protocol, { gas_price: "1000000001" }), /policy/);
});

test("mainnet funding needs the original sole FullAccess key and balance above storage and the complete cap", () => {
  const account = {
    code_hash: "1".repeat(32),
    locked: "0",
    storage_usage: 182,
    amount: "250000000000000000000000",
  };
  const keys = {
    keys: [{ public_key: mainnetAccount.publicKey, access_key: { permission: "FullAccess" } }],
  };
  assert.deepEqual(controllerFunding(account, keys), {
    amount: account.amount,
    storageReserve: "1820000000000000000000",
    availableForFees: "248180000000000000000000",
    sufficient: true,
  });
  assert.equal(
    controllerFunding({ ...account, amount: "103819999999999999999999" }, keys).sufficient,
    false,
  );
  assert.equal(
    controllerFunding({ ...account, amount: "103820000000000000000000" }, keys).sufficient,
    true,
  );
  assert.equal(controllerFunding({ ...account, amount: "0" }, keys).availableForFees, "0");
  assert.throws(() => controllerFunding({ ...account, locked: "1" }, keys), /locked/);
  assert.throws(
    () =>
      controllerFunding(account, {
        keys: [{ ...keys.keys[0], access_key: { permission: { FunctionCall: {} } } }],
      }),
    /FullAccess/,
  );
  assert.throws(
    () => controllerFunding(account, { keys: [...keys.keys, ...keys.keys] }),
    /FullAccess/,
  );
  assert.throws(
    () =>
      controllerFunding(account, {
        keys: [{ ...keys.keys[0], public_key: "ed25519:" + "1".repeat(32) }],
      }),
    /FullAccess/,
  );
});
