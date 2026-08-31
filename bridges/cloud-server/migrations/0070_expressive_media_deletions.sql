-- Keep a tombstone for deleted saved media so older clients cannot recreate
-- the library entry during their next reconciliation pass.

ALTER TABLE cloud_expressive_media_items
    ADD COLUMN IF NOT EXISTS deleted_at TEXT;
