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

test("hosted production only connects to its named private Railway database", () => {
  const host = "postgres.railway.internal";
  const configured = {
    NODE_ENV: "production",
    SHOWUP_ENV: "production",
    SHOWUP_DATABASE_HOST: host,
    DATABASE_URL: `postgresql://showup:fake-password@${host}:5432/showup`,
  };
  assert.equal(databaseConfig(configured).purpose, "production");
  for (const DATABASE_URL of [
    `postgresql://showup@${host}/showup`,
    `postgresql://showup:fake-password@${host}/showup_test`,
    `postgresql://showup:fake-password@${host}:1234/showup`,
    `postgresql://showup:fake-password@${host}/showup?host=public.example`,
    "postgresql://showup:fake-password@other.railway.internal/showup",
    "postgresql://showup:fake-password@localhost/showup",
  ])
    assert.throws(
      () => databaseConfig({ ...configured, DATABASE_URL }),
      (error: Error) => !error.message.includes("fake-password"),
    );
  assert.throws(() => databaseConfig({ ...configured, NODE_ENV: "development" }));
});
