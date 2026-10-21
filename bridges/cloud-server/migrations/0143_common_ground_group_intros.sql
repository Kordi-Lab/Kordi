-- The introduction PiP posts as the first message of a group started from a
-- Common ground room. One row per intro run; `posted_at` is set when the
-- message is in the group, `error_code` when the run failed.

CREATE TABLE IF NOT EXISTS cloud_common_ground_group_intros (
    run_id          TEXT PRIMARY KEY,
    conversation_id UUID NOT NULL,
    group_space_id  TEXT NOT NULL REFERENCES cloud_common_ground_room_groups(group_space_id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at       TIMESTAMPTZ NULL,
    error_code      TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_group_intros_group
    ON cloud_common_ground_group_intros (group_space_id);
