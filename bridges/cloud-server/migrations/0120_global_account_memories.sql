-- Account memories gain a `global` scope for preferences that apply to every
-- conversation. Global memories always use the scope id `account`.
ALTER TABLE cloud_account_memories DROP CONSTRAINT IF EXISTS cloud_account_memories_scope_check;
ALTER TABLE cloud_account_memories ADD CONSTRAINT cloud_account_memories_scope_check
    CHECK (scope IN ('global', 'conversation', 'group', 'project'));
