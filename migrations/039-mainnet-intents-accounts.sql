CREATE TABLE app_v1_route_accounts (
  registration_id uuid PRIMARY KEY REFERENCES app_v1_registrations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','prepared','submitted','verified','failed')),
  transaction_hash text,
  encrypted_transaction text,
  source_height numeric(20,0),
  gas_yocto_near numeric(40,0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((transaction_hash IS NULL)=(encrypted_transaction IS NULL))
);
ALTER TABLE app_v1_route_quotes ADD COLUMN intents_checked_at timestamptz;
CREATE TABLE app_v1_route_withdrawals (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES app_v1_registrations(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  image_hash text NOT NULL,
  encrypted_image text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','prepared','submitted','verified','failed')),
  transaction_hash text,
  encrypted_transaction text,
  source_height numeric(20,0),
  gas_yocto_near numeric(40,0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(registration_id,attempt),
  CHECK((transaction_hash IS NULL)=(encrypted_transaction IS NULL))
);
