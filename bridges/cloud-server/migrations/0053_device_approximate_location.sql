-- Persist only the coarse, user-visible location reported by an installation.
-- Raw IP addresses and precise coordinates are never stored on device records.

ALTER TABLE cloud_devices
    ADD COLUMN IF NOT EXISTS approximate_location TEXT;
