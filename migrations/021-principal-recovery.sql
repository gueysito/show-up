CREATE TABLE app_principal_recoveries (
  consent_id uuid PRIMARY KEY REFERENCES app_commitment_consents(id) ON DELETE CASCADE,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  encrypted_request text NOT NULL CHECK(encrypted_request<>''),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','broadcast_unknown','pending_transfer','awaiting_liability','observed','unavailable','conflict')),
  claim_token uuid,
  claim_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  submitted_attempt numeric(20,0) CHECK(submitted_attempt BETWEEN 1 AND 18446744073709551615),
  observed_height numeric(20,0) CHECK(observed_height BETWEEN 1 AND 18446744073709551615),
  observed_hash text,
  encrypted_observation text,
  last_error text CHECK(last_error IN ('source_unavailable','submission_unknown','source_conflict','attempt_limit')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((claim_token IS NULL)=(claim_until IS NULL)),
  CHECK((observed_height IS NULL)=(observed_hash IS NULL)),
  CHECK((observed_height IS NULL)=(encrypted_observation IS NULL)),
  CHECK(state<>'observed' OR observed_height IS NOT NULL)
);
