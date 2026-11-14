CREATE TABLE app_commitment_consents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  event_id uuid NOT NULL REFERENCES app_events(id),
  session_hash text NOT NULL REFERENCES app_sessions(token_hash),
  consent_hash text NOT NULL CHECK (consent_hash ~ '^[0-9a-f]{64}$'),
  encrypted_consent text NOT NULL,
  signing_expires_at timestamptz NOT NULL,
  authorization_expires_at timestamptz NOT NULL,
  authorized_at timestamptz,
  encrypted_proof text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((authorized_at IS NULL) = (encrypted_proof IS NULL)),
  CHECK (signing_expires_at <= authorization_expires_at)
);
CREATE INDEX app_commitment_consents_owner ON app_commitment_consents(account_id, event_id, created_at DESC);
