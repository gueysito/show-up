ALTER TABLE app_publication_images
  DROP CONSTRAINT app_publication_images_transaction_state_check,
  ADD CONSTRAINT app_publication_images_transaction_state_check
    CHECK (transaction_state IN ('requested','prepared','submitted','awaiting_prize','verified','failed','cancelled'));

ALTER TABLE app_v1_event_actions DROP CONSTRAINT app_v1_event_actions_kind_check,
  ADD CONSTRAINT app_v1_event_actions_kind_check
    CHECK(kind IN ('check_in','settle','cancel','withdraw','nft_release','nft_retry','nft_derive'));
ALTER TABLE app_v1_event_actions ADD COLUMN nft_delivery_checked_at timestamptz;

CREATE TABLE app_v1_nft_wallet_payments (
  event_id uuid NOT NULL REFERENCES app_events(id),
  purpose text NOT NULL CHECK(purpose IN ('nft','gas')),
  payment_hash text NOT NULL,
  encrypted_payment text NOT NULL,
  source_hash text,
  PRIMARY KEY(event_id,purpose)
);
CREATE TABLE app_v1_nft_deliveries (
  event_id uuid PRIMARY KEY REFERENCES app_events(id),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitted','delivered','failed')),
  transaction_hash text NOT NULL,
  encrypted_transaction text NOT NULL,
  source_height numeric(20,0),
  execution_fee_wei numeric(40,0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
