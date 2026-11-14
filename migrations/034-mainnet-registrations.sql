CREATE TABLE app_v1_registrations (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_events(id),
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  payout_index text NOT NULL CHECK(payout_index ~ '^[0-9a-f]{64}$'),
  image_hash text NOT NULL CHECK(image_hash ~ '^[0-9a-f]{64}$'),
  encrypted_image text NOT NULL,
  state text NOT NULL DEFAULT 'requested'
    CHECK(state IN ('requested','prepared','submitted','registered','funded','failed')),
  transaction_hash text,
  encrypted_transaction text,
  source_height numeric(20,0),
  funding_height numeric(20,0),
  gas_yocto_near numeric(40,0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,account_id),
  UNIQUE(event_id,payout_index),
  CHECK((transaction_hash IS NULL)=(encrypted_transaction IS NULL))
);
CREATE INDEX v1_registration_queue ON app_v1_registrations(created_at,id)
  WHERE state IN ('requested','prepared','submitted');
