-- The room topic a Common ground group was started for, when it came from
-- one. Groups started from the whole room keep NULL.

ALTER TABLE cloud_common_ground_room_groups
    ADD COLUMN IF NOT EXISTS topic TEXT NULL;
