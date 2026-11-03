CREATE TABLE app_attendance_qr (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_events(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  consent_id uuid NOT NULL,
  credential_index text NOT NULL UNIQUE CHECK(credential_index ~ '^[0-9a-f]{64}$'),
  encrypted_payload text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '60 seconds'),
  retired_at timestamptz,
  consumed_at timestamptz,
  candidate_id uuid REFERENCES app_attendance_candidates(id),
  CHECK((consumed_at IS NULL)=(candidate_id IS NULL)),
  FOREIGN KEY(consent_id,account_id,event_id)
    REFERENCES app_commitment_consents(id,account_id,event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX attendance_qr_active ON app_attendance_qr(event_id,account_id)
  WHERE retired_at IS NULL AND consumed_at IS NULL;
CREATE TABLE app_attendance_qr_scans (
  id uuid PRIMARY KEY,
  qr_id uuid NOT NULL REFERENCES app_attendance_qr(id) ON DELETE CASCADE,
  validator_id uuid NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  scanned_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  UNIQUE(qr_id,validator_id,session_hash)
);
