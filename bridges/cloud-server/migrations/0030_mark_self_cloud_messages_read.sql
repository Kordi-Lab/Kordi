UPDATE cloud_messages
SET read_at = COALESCE(read_at, delivered_at, created_at)
WHERE from_account_id = to_account_id
  AND read_at IS NULL;

INSERT INTO cloud_read_cursors (account_id, scope_kind, scope_id, read_at, updated_at)
SELECT
    to_account_id,
    'peer',
    to_account_id,
    MAX(COALESCE(read_at, delivered_at, created_at)),
    MAX(COALESCE(read_at, delivered_at, created_at))
FROM cloud_messages
WHERE from_account_id = to_account_id
GROUP BY to_account_id
ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET
    read_at = GREATEST(cloud_read_cursors.read_at, EXCLUDED.read_at),
    updated_at = EXCLUDED.updated_at;

INSERT INTO cloud_read_cursors (account_id, scope_kind, scope_id, read_at, updated_at)
SELECT
    to_account_id,
    'session',
    session_id,
    MAX(COALESCE(read_at, delivered_at, created_at)),
    MAX(COALESCE(read_at, delivered_at, created_at))
FROM cloud_messages
WHERE from_account_id = to_account_id
  AND session_id IS NOT NULL
  AND session_id <> ''
GROUP BY to_account_id, session_id
ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET
    read_at = GREATEST(cloud_read_cursors.read_at, EXCLUDED.read_at),
    updated_at = EXCLUDED.updated_at;
