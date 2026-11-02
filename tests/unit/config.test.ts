import assert from "node:assert/strict";
import test from "node:test";
import { databaseConfig } from "../../src/server/config";

test("database selection fails closed without printing values", () => {
  assert.throws(() => databaseConfig({}), /SHOWUP_ENV/);
  for (const url of [
    "postgres://private:do-not-print@remote.example/showup_dev",
    "postgres://localhost/production",
    "postgres://localhost/showup_dev?host=remote.example",
    "postgres://localhost/showup_test",
  ]) {
    assert.throws(
      () => databaseConfig({ SHOWUP_ENV: "development", DATABASE_URL: url }),
      (error: Error) => !error.message.includes("do-not-print"),
    );
  }
  assert.equal(
    databaseConfig({ SHOWUP_ENV: "test", DATABASE_URL: "postgres://localhost/showup_test" })
      .purpose,
    "test",
  );
});
