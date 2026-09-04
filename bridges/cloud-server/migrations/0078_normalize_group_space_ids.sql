UPDATE cloud_chat_conversations
SET group_space_id = regexp_replace(group_space_id, '^(group:)+', '')
WHERE group_space_id LIKE 'group:%';
