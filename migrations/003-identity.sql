CREATE TABLE app_accounts (
  id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deletion_requested', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_identities (
  identity_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  provider text NOT NULL CHECK (provider IN ('google', 'telegram')),
  encrypted_identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider)
);

CREATE TABLE app_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX app_sessions_account ON app_sessions(account_id);

CREATE TABLE app_login_attempts (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'telegram')),
  encrypted_checks text NOT NULL,
  linking_session_hash text REFERENCES app_sessions(token_hash),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE app_roles (
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  role text NOT NULL CHECK (role IN ('admin', 'host')),
  PRIMARY KEY (account_id, role)
);

CREATE TABLE app_rate_limits (
  key_hash text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0)
);

CREATE TABLE app_audit (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES app_accounts(id),
  action text NOT NULL,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
