CREATE TABLE app_deletion_requests (
  account_id uuid PRIMARY KEY REFERENCES app_accounts(id),
  id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  hold_reasons text[] NOT NULL DEFAULT '{}',
  CHECK (hold_reasons <@ ARRAY['financial_reconciliation','published_event_obligations']::text[]),
  CHECK (completed_at IS NULL OR cardinality(hold_reasons)=0)
);
