CREATE INDEX app_attendance_intakes_completed ON app_attendance_intakes(completed_at,id) WHERE completed_at IS NOT NULL;
