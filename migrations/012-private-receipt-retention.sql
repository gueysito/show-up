ALTER TABLE app_mutations ADD COLUMN payload_expires_at timestamptz;
ALTER TABLE app_mutations ADD COLUMN payload_retired_at timestamptz;
ALTER TABLE app_mutations ADD CONSTRAINT mutation_retired_payload CHECK (
  (payload_retired_at IS NULL AND encrypted_receipt<>'') OR
  (payload_retired_at IS NOT NULL AND encrypted_receipt='')
);
CREATE INDEX app_mutations_retention ON app_mutations(payload_expires_at,created_at)
  WHERE payload_retired_at IS NULL;
CREATE INDEX app_audit_retention ON app_audit(created_at);
CREATE INDEX app_wallet_challenges_retention ON app_wallet_challenges(expires_at);
