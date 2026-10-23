-- The daily kind's default name is now "Daily". Rename only profiles that
-- still carry the old default; names people chose stay as they are.

UPDATE cloud_common_ground_profiles
SET name = 'Daily'
WHERE kind = 'daily' AND name = 'Daily tasks';
