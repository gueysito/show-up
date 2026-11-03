ALTER TABLE app_attendance_deliveries ADD CONSTRAINT observed_attendance_requires_signature
  CHECK(state<>'observed' OR signed_hash IS NOT NULL);
