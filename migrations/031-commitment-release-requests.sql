CREATE TABLE app_commitment_releases (
  operation_id uuid PRIMARY KEY,
  consent_id uuid NOT NULL REFERENCES app_commitment_consents(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  image_hash text NOT NULL CHECK(image_hash ~ '^[0-9a-f]{64}$'),
  encrypted_image text NOT NULL CHECK(encrypted_image<>''),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX app_commitment_releases_owner ON app_commitment_releases(account_id,created_at);
