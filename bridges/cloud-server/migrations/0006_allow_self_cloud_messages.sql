-- Allow private self-scoped Cloud conversations for a user's own Kordi agent.
-- Privacy is preserved by auth scoping: both from_account_id and to_account_id
-- are the authenticated account, and list queries are session-scoped.
ALTER TABLE cloud_messages DROP CONSTRAINT IF EXISTS cloud_messages_check;
