INSERT INTO cloud_read_cursors (account_id, scope_kind, scope_id, read_at, updated_at)
SELECT
    to_account_id,
    'peer',
    from_account_id,
    MAX(read_at),
    MAX(read_at)
FROM cloud_messages
WHERE read_at IS NOT NULL
  AND from_account_id <> to_account_id
GROUP BY to_account_id, from_account_id
ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET
    read_at = CASE
        WHEN cloud_read_cursors.read_at < EXCLUDED.read_at THEN EXCLUDED.read_at
        ELSE cloud_read_cursors.read_at
    END,
    updated_at = EXCLUDED.updated_at;

INSERT INTO cloud_read_cursors (account_id, scope_kind, scope_id, read_at, updated_at)
SELECT
    to_account_id,
    'session',
    session_id,
    MAX(read_at),
    MAX(read_at)
FROM cloud_messages
WHERE read_at IS NOT NULL
  AND session_id IS NOT NULL
  AND session_id <> ''
GROUP BY to_account_id, session_id
ON CONFLICT (account_id, scope_kind, scope_id) DO UPDATE SET
    read_at = CASE
        WHEN cloud_read_cursors.read_at < EXCLUDED.read_at THEN EXCLUDED.read_at
        ELSE cloud_read_cursors.read_at
    END,
    updated_at = EXCLUDED.updated_at;
