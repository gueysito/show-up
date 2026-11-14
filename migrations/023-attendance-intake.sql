CREATE TABLE app_attendance_intake_events (
  event_id uuid PRIMARY KEY REFERENCES app_events(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  received_count bigint NOT NULL DEFAULT 0 CHECK(received_count>=0),
  pending_count bigint NOT NULL DEFAULT 0 CHECK(pending_count>=0 AND pending_count<=received_count),
  had_unavailable boolean NOT NULL DEFAULT false
);
CREATE TABLE app_attendance_intakes (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES app_attendance_intake_events(event_id) ON DELETE CASCADE,
  account_id uuid REFERENCES app_accounts(id) ON DELETE SET NULL,
  operation_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK(action IN ('attendance.code-attempt','attendance.qr-issued','attendance.qr-scanned','attendance.qr-confirmed')),
  received_at_ms bigint NOT NULL CHECK(received_at_ms>=0),
  completed_at timestamptz,
  outcome text CHECK(outcome IN ('receipt','rejected')),
  CHECK((completed_at IS NULL)=(outcome IS NULL))
);
CREATE INDEX app_attendance_intakes_pending ON app_attendance_intakes(event_id,operation_id,request_hash) WHERE completed_at IS NULL;
CREATE INDEX app_attendance_intakes_owner ON app_attendance_intakes(account_id,event_id);
