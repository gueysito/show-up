CREATE TABLE app_attendance_code_windows (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_events(id) ON DELETE CASCADE,
  code_index text NOT NULL CHECK (code_index ~ '^[0-9a-f]{64}$'),
  encrypted_code text NOT NULL CHECK (encrypted_code<>''),
  opened_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  retired_at timestamptz,
  CHECK (expires_at>opened_at AND expires_at<=opened_at+interval '3 minutes'),
  CHECK (retired_at IS NULL OR retired_at>=opened_at),
  UNIQUE(event_id,code_index)
);
CREATE UNIQUE INDEX app_attendance_current_code ON app_attendance_code_windows(event_id)
  WHERE retired_at IS NULL;
