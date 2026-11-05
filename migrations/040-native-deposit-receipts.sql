ALTER TABLE app_v1_registrations
  ADD COLUMN funding_transaction_hash text
    CHECK (funding_transaction_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
