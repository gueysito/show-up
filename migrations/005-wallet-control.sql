CREATE TABLE app_wallet_challenges (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  session_hash text NOT NULL REFERENCES app_sessions(token_hash),
  encrypted_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX app_wallet_challenges_owner ON app_wallet_challenges(account_id, expires_at);

CREATE TABLE app_wallets (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  wallet_index text NOT NULL,
  network text NOT NULL CHECK (network IN ('near','base','ethereum','solana')),
  encrypted_wallet text NOT NULL,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, wallet_index)
);
CREATE INDEX app_wallets_owner ON app_wallets(account_id, created_at);
