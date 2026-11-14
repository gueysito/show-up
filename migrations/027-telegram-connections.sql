CREATE TABLE app_telegram_connections (
  account_id uuid PRIMARY KEY REFERENCES app_accounts(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE,
  bot_id text NOT NULL,
  bot_username text NOT NULL,
  sender_hash text NOT NULL UNIQUE,
  encrypted_peer text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE app_telegram_connection_attempts (
  account_id uuid PRIMARY KEY REFERENCES app_accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  session_hash text NOT NULL REFERENCES app_sessions(token_hash) ON DELETE CASCADE,
  bot_id text NOT NULL,
  expected_sender_hash text NOT NULL,
  event_id uuid REFERENCES app_events(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_update_id bigint,
  connection_id uuid REFERENCES app_telegram_connections(id) ON DELETE SET NULL
);
CREATE INDEX app_telegram_attempt_expiry ON app_telegram_connection_attempts(expires_at,account_id);
