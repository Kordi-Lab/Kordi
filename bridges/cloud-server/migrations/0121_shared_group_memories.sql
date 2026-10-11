-- Group memories are shared by the group: every active member lists the
-- non-archived memories whose scope id is the group id, whoever saved them.
-- This index serves that lookup by group id.
CREATE INDEX IF NOT EXISTS cloud_account_memories_group_scope_idx
    ON cloud_account_memories (scope_id)
    WHERE scope = 'group' AND archived_at IS NULL;
