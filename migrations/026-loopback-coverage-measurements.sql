CREATE TABLE service_coverage_epochs (
  id uuid PRIMARY KEY,
  inventory_hash text NOT NULL CHECK(inventory_hash ~ '^[0-9a-f]{64}$'),
  max_gap_ms integer NOT NULL CHECK(max_gap_ms BETWEEN 100 AND 10000),
  had_gap boolean NOT NULL DEFAULT false,
  started_ms bigint NOT NULL CHECK(started_ms>=0),
  through_ms bigint NOT NULL CHECK(through_ms>=started_ms),
  last_ms bigint NOT NULL CHECK(last_ms>=0),
  sequence integer NOT NULL DEFAULT 0 CHECK(sequence BETWEEN 0 AND 250000),
  head_hash text NOT NULL CHECK(head_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','gap','stopped'))
);
CREATE TABLE service_coverage_requests (
  id uuid PRIMARY KEY,
  epoch_id uuid NOT NULL REFERENCES service_coverage_epochs(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK(channel IN ('admission','host_code','code_entry','qr_issue','qr_scan','presence_confirmation','unknown')),
  received_ms bigint NOT NULL CHECK(received_ms>=0),
  completed_ms bigint,
  status integer CHECK(status=0 OR status BETWEEN 100 AND 599),
  CHECK((completed_ms IS NULL)=(status IS NULL))
);
CREATE INDEX service_coverage_requests_epoch ON service_coverage_requests(epoch_id,received_ms,id);
CREATE TABLE service_coverage_records (
  epoch_id uuid NOT NULL REFERENCES service_coverage_epochs(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 250000),
  record_hash text NOT NULL CHECK(record_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  PRIMARY KEY(epoch_id,sequence)
);
