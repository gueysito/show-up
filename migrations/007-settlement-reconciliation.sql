CREATE TABLE app_settlement_watches (
  id uuid PRIMARY KEY,
  context_index text NOT NULL UNIQUE,
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  encrypted_context text NOT NULL,
  observed_height numeric(20,0),
  observed_hash text,
  observed_time_ms bigint,
  observed_state_hash text,
  ledger_version numeric(20,0),
  encrypted_state text,
  available boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  pause_reason text CHECK (pause_reason IN ('source_conflict','state_regression')),
  conflict_hash text,
  encrypted_conflict text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((observed_height IS NULL AND observed_hash IS NULL AND observed_time_ms IS NULL
    AND observed_state_hash IS NULL AND ledger_version IS NULL AND encrypted_state IS NULL)
    OR (observed_height BETWEEN 1 AND 18446744073709551615 AND observed_hash IS NOT NULL
    AND observed_time_ms >= 0 AND observed_state_hash IS NOT NULL
    AND ledger_version BETWEEN 0 AND 18446744073709551615 AND encrypted_state IS NOT NULL)),
  CHECK ((paused_at IS NULL) = (pause_reason IS NULL)),
  CHECK ((conflict_hash IS NULL) = (encrypted_conflict IS NULL)),
  CHECK (NOT available OR (encrypted_state IS NOT NULL AND paused_at IS NULL))
);
