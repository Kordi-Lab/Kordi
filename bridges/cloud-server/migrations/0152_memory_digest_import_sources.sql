-- Memories gain two sources: `digest` for memories a digest run saves from
-- recent conversations (#2053), and `import` for memories the Mac imports
-- from the person's instruction files (#2054).
ALTER TABLE cloud_account_memories DROP CONSTRAINT IF EXISTS cloud_account_memories_source_check;
ALTER TABLE cloud_account_memories ADD CONSTRAINT cloud_account_memories_source_check
    CHECK (source IN ('user_correction', 'repeated_failure', 'outcome', 'manual', 'digest', 'import'));
