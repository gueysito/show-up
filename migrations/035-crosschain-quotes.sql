CREATE TABLE app_v1_route_quotes (
  registration_id uuid PRIMARY KEY REFERENCES app_v1_registrations(id) ON DELETE CASCADE,
  quote_hash text NOT NULL CHECK(quote_hash ~ '^[0-9a-f]{64}$'),
  encrypted_quote text NOT NULL,
  expires_at timestamptz NOT NULL,
  source_transaction_hash text CHECK(length(source_transaction_hash)<=128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
