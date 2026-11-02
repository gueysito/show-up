CREATE TABLE harness_workspaces (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0
);

CREATE TABLE event_drafts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES harness_workspaces(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state = 'DRAFT'),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_drafts_workspace ON event_drafts (workspace_id, updated_at);

CREATE TABLE draft_mutations (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES harness_workspaces(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  receipt jsonb NOT NULL
);
