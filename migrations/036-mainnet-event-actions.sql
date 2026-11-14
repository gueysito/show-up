CREATE TABLE app_v1_code_windows (
  event_id uuid PRIMARY KEY REFERENCES app_events(id),
  code_index text NOT NULL,
  encrypted_code text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE app_v1_event_actions (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_events(id),
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  kind text NOT NULL CHECK(kind IN ('check_in','settle','cancel','withdraw')),
  target text NOT NULL,
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  image_hash text NOT NULL CHECK(image_hash ~ '^[0-9a-f]{64}$'),
  encrypted_image text NOT NULL,
  state text NOT NULL DEFAULT 'requested'
    CHECK(state IN ('requested','prepared','submitted','verified','failed')),
  transaction_hash text,
  encrypted_transaction text,
  source_height numeric(20,0),
  gas_yocto_near numeric(40,0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,kind,target,attempt),
  CHECK((transaction_hash IS NULL)=(encrypted_transaction IS NULL))
);
CREATE INDEX v1_event_action_queue ON app_v1_event_actions(created_at,id)
  WHERE state IN ('requested','prepared','submitted');
