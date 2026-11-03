CREATE TABLE app_telegram_attendance_prompts (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES app_telegram_connections(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES app_events(id),
  consent_id uuid NOT NULL REFERENCES app_commitment_consents(id),
  code_hash text NOT NULL UNIQUE,
  encrypted_prompt text NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','sending','sent','unknown')),
  message_id bigint,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(connection_id,event_id,consent_id)
);
CREATE TABLE app_telegram_attendance_replies (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL,
  update_id bigint NOT NULL CHECK(update_id>=0),
  prompt_id uuid NOT NULL REFERENCES app_telegram_attendance_prompts(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE,
  code_index text NOT NULL,
  environment text NOT NULL CHECK(environment IN ('sandbox','mainnet')),
  received_ms bigint NOT NULL CHECK(received_ms>=0),
  UNIQUE(bot_id,update_id)
);
CREATE INDEX app_telegram_prompt_expiry ON app_telegram_attendance_prompts(expires_at,id);
