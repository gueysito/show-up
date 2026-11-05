ALTER TABLE app_publication_images
  DROP CONSTRAINT app_publication_images_transaction_state_check,
  ADD CONSTRAINT app_publication_images_transaction_state_check
    CHECK (transaction_state IN ('requested','prepared','submitted','awaiting_prize','verified','failed')),
  ADD COLUMN execution_phase text NOT NULL DEFAULT 'atomic'
    CHECK (execution_phase IN ('atomic','create','publish')),
  ADD COLUMN creation_transaction_hash text,
  ADD COLUMN creation_encrypted_transaction text,
  ADD COLUMN creation_gas_yocto_near numeric(40,0),
  ADD COLUMN creation_source_height numeric(20,0),
  ADD CONSTRAINT publication_creation_pair
    CHECK ((creation_transaction_hash IS NULL) = (creation_encrypted_transaction IS NULL));
