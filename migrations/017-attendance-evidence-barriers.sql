CREATE TABLE app_attendance_evidence_barriers (
  event_id uuid PRIMARY KEY REFERENCES app_events(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK(environment='sandbox'),
  context_hash text NOT NULL CHECK(context_hash ~ '^[0-9a-f]{64}$'),
  complete_through_ms bigint NOT NULL CHECK(complete_through_ms>=0),
  frozen_at_ms bigint NOT NULL CHECK(frozen_at_ms>=complete_through_ms+300000),
  candidate_count integer NOT NULL CHECK(candidate_count BETWEEN 0 AND 100),
  manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
  encrypted_manifest text NOT NULL CHECK(encrypted_manifest<>'')
);
CREATE TABLE app_attendance_checkpoints (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_attendance_evidence_barriers(event_id) ON DELETE CASCADE,
  checkpoint_hash text NOT NULL UNIQUE CHECK(checkpoint_hash ~ '^[0-9a-f]{64}$'),
  observed_height numeric(20,0) NOT NULL CHECK(observed_height BETWEEN 1 AND 18446744073709551615),
  observed_hash text NOT NULL,
  ledger_version numeric(20,0) NOT NULL CHECK(ledger_version BETWEEN 0 AND 18446744073709551615),
  encrypted_checkpoint text NOT NULL CHECK(encrypted_checkpoint<>'')
);
