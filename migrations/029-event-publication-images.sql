CREATE TABLE app_publication_images (
  event_id uuid PRIMARY KEY REFERENCES app_events(id),
  draft_revision integer NOT NULL CHECK(draft_revision>0),
  image_hash text NOT NULL CHECK(image_hash ~ '^[0-9a-f]{64}$'),
  encrypted_image text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_source_hash text CHECK(observed_source_hash ~ '^[0-9a-f]{64}$'),
  source_height numeric(20,0) CHECK(source_height>=0),
  source_block text,
  observed_at timestamptz,
  CHECK((observed_source_hash IS NULL)=(observed_at IS NULL)),
  CHECK((source_height IS NULL)=(observed_at IS NULL)),
  CHECK((source_block IS NULL)=(observed_at IS NULL))
);
