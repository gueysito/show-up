ALTER TABLE app_deletion_requests DROP CONSTRAINT app_deletion_requests_hold_reasons_check;
ALTER TABLE app_deletion_requests ADD CONSTRAINT app_deletion_requests_hold_reasons_check
  CHECK (hold_reasons <@ ARRAY['financial_reconciliation','published_event_obligations','publication_reconciliation']::text[]);
