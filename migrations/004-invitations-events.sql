CREATE TABLE app_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app_accounts(id),
  revision integer NOT NULL CHECK (revision > 0),
  data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','cancelled','aborted','closed')),
  rules_hash text,
  registration_closes_at timestamptz NOT NULL,
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state='draft' AND published_at IS NULL AND rules_hash IS NULL) OR
    (state<>'draft' AND published_at IS NOT NULL AND rules_hash IS NOT NULL))
);
CREATE INDEX app_events_owner ON app_events(owner_id, updated_at DESC);

CREATE TABLE app_invitations (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  issuer_id uuid NOT NULL REFERENCES app_accounts(id),
  kind text NOT NULL CHECK (kind IN ('host','event')),
  event_id uuid REFERENCES app_events(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  redeemed_by uuid REFERENCES app_accounts(id),
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='host' AND event_id IS NULL) OR (kind='event' AND event_id IS NOT NULL)),
  CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
);

CREATE TABLE app_event_access (
  event_id uuid NOT NULL REFERENCES app_events(id),
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  invitation_id uuid NOT NULL REFERENCES app_invitations(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, account_id)
);

CREATE TABLE app_mutations (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES app_accounts(id),
  request_hash text NOT NULL,
  encrypted_receipt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
