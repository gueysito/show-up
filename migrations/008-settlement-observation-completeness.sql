-- CHECK permits NULL results. Count populated fields explicitly so a partial
-- observation cannot pass the separate numeric/bounds invariant via NULL logic.
ALTER TABLE app_settlement_watches
  ADD CONSTRAINT app_settlement_watches_complete_observation CHECK (
    num_nonnulls(observed_height, observed_hash, observed_time_ms,
      observed_state_hash, ledger_version, encrypted_state) IN (0, 6)
  );
