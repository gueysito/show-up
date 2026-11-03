CREATE TABLE app_event_credentials (
  event_id uuid NOT NULL REFERENCES app_events(id),
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  encrypted_credential text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, account_id)
);
