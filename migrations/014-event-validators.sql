ALTER TABLE app_invitations DROP CONSTRAINT app_invitations_kind_check;
ALTER TABLE app_invitations DROP CONSTRAINT app_invitations_check;
ALTER TABLE app_invitations ADD CONSTRAINT invitation_kind CHECK (kind IN ('host','event','validator'));
ALTER TABLE app_invitations ADD CONSTRAINT invitation_scope CHECK (
  (kind='host' AND event_id IS NULL) OR (kind IN ('event','validator') AND event_id IS NOT NULL)
);
ALTER TABLE app_invitations DROP CONSTRAINT app_invitations_event_id_fkey;
ALTER TABLE app_invitations ADD CONSTRAINT app_invitations_event_id_fkey
  FOREIGN KEY(event_id) REFERENCES app_events(id) ON DELETE CASCADE;
ALTER TABLE app_event_credentials DROP CONSTRAINT app_event_credentials_event_id_fkey;
ALTER TABLE app_event_credentials ADD CONSTRAINT app_event_credentials_event_id_fkey
  FOREIGN KEY(event_id) REFERENCES app_events(id) ON DELETE CASCADE;
CREATE TABLE app_event_validators (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_events(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  invitation_id uuid NOT NULL REFERENCES app_invitations(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (alias ~ '^Validator [0-9a-f]{16}$'),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE(event_id,account_id)
);
