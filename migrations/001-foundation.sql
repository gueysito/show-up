CREATE TABLE outbox (
  operation_id uuid PRIMARY KEY,
  topic text NOT NULL CHECK (topic IN ('foundation.probe', 'draft.saved')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending ON outbox (created_at) WHERE dispatched_at IS NULL;

CREATE TABLE processed_operations (
  operation_id uuid PRIMARY KEY REFERENCES outbox(operation_id),
  topic text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
