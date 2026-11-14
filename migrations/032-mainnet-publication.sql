ALTER TABLE app_publication_images
  ADD COLUMN environment text NOT NULL DEFAULT 'sandbox'
    CHECK (environment IN ('sandbox','near-mainnet-v1')),
  ADD COLUMN transaction_state text NOT NULL DEFAULT 'requested'
    CHECK (transaction_state IN ('requested','prepared','submitted','verified','failed')),
  ADD COLUMN transaction_hash text,
  ADD COLUMN encrypted_transaction text,
  ADD COLUMN gas_yocto_near numeric(40,0) CHECK (gas_yocto_near>=0),
  ADD COLUMN failure_code text CHECK (failure_code IN ('event_started','transaction_failed')),
  ADD CONSTRAINT publication_transaction_pair
    CHECK ((transaction_hash IS NULL) = (encrypted_transaction IS NULL));
