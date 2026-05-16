-- Dry-run only. This file counts stale localhost/local Bridge artifacts that
-- should not be visible to Cloud Edition after issue #449.

WITH legacy_uuid_self AS (
  SELECT message_id
  FROM cloud_messages
  WHERE session_id !~ '^session:(direct-person|group|fork):'
    AND from_account_id = to_account_id
), possible_kh_group_controls AS (
  SELECT message_id
  FROM cloud_messages
  WHERE body LIKE 'kordi-cloud-group:%'
    AND body LIKE '%kh_%'
)
SELECT 'legacy_uuid_self_messages' AS check_name, count(*) AS row_count FROM legacy_uuid_self
UNION ALL
SELECT 'possible_kh_group_controls' AS check_name, count(*) AS row_count FROM possible_kh_group_controls;
