ALTER TABLE app_commitment_consents ADD CONSTRAINT consent_owner_event UNIQUE(id,account_id,event_id);
CREATE TABLE app_attendance_code_attempts (
  window_id uuid NOT NULL REFERENCES app_attendance_code_windows(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  PRIMARY KEY(window_id,account_id)
);
CREATE TABLE app_attendance_candidates (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_events(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  consent_id uuid NOT NULL,
  window_id uuid REFERENCES app_attendance_code_windows(id) ON DELETE SET NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox','mainnet')),
  classification text NOT NULL CHECK (classification IN ('on_time','late')),
  received_at timestamptz NOT NULL,
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^[0-9a-f]{64}$'),
  encrypted_candidate text NOT NULL CHECK (encrypted_candidate<>''),
  UNIQUE(event_id,account_id),
  FOREIGN KEY(consent_id,account_id,event_id)
    REFERENCES app_commitment_consents(id,account_id,event_id) ON DELETE CASCADE
);
