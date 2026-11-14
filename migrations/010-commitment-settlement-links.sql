CREATE TABLE app_commitment_settlement_links (
  consent_id uuid PRIMARY KEY REFERENCES app_commitment_consents(id),
  watch_id uuid NOT NULL UNIQUE REFERENCES app_settlement_watches(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
