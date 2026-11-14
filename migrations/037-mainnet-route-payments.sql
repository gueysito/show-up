ALTER TABLE app_v1_route_quotes
  ADD COLUMN payment_hash text CHECK(payment_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN encrypted_payment text,
  ADD CONSTRAINT route_original_payment_pair
    CHECK((payment_hash IS NULL)=(encrypted_payment IS NULL));
