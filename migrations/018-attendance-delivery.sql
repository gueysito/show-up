CREATE TABLE app_attendance_deliveries (
  candidate_id uuid PRIMARY KEY REFERENCES app_attendance_candidates(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','broadcast_unknown','observed','awaiting_reconciliation','unavailable','conflict')),
  profile_hash text CHECK(profile_hash ~ '^[0-9a-f]{64}$'),
  signed_hash text CHECK(signed_hash ~ '^[0-9a-f]{64}$'),
  encrypted_signed text,
  claim_token uuid,
  claim_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  observed_height numeric(20,0) CHECK(observed_height BETWEEN 1 AND 18446744073709551615),
  observed_hash text,
  encrypted_observation text,
  last_error text CHECK(last_error IN ('source_unavailable','signing_unavailable','submission_unknown','receipt_expired','source_conflict')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((signed_hash IS NULL)=(encrypted_signed IS NULL)),
  CHECK(encrypted_signed IS NULL OR encrypted_signed<>''),
  CHECK((claim_token IS NULL)=(claim_until IS NULL)),
  CHECK((observed_height IS NULL)=(observed_hash IS NULL)),
  CHECK((observed_height IS NULL)=(encrypted_observation IS NULL)),
  CHECK(state<>'observed' OR observed_height IS NOT NULL)
);
INSERT INTO app_attendance_deliveries(candidate_id) SELECT id FROM app_attendance_candidates;
