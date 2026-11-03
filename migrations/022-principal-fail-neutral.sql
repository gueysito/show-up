ALTER TABLE app_principal_recoveries
  ADD COLUMN neutral_hash text CHECK(neutral_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN encrypted_neutral_request text,
  ADD COLUMN last_effect text CHECK(last_effect IN ('fail_neutral','withdraw')),
  ADD CONSTRAINT principal_neutral_pair CHECK((neutral_hash IS NULL)=(encrypted_neutral_request IS NULL)),
  ADD CONSTRAINT principal_neutral_material CHECK(encrypted_neutral_request IS NULL OR encrypted_neutral_request<>'');
UPDATE app_principal_recoveries SET last_effect='withdraw' WHERE submitted_attempt IS NOT NULL;
