-- Preserve coarse installation location across the external OAuth redirect so
-- an already authorized device can review a new login immediately.

ALTER TABLE cloud_oauth_states
    ADD COLUMN IF NOT EXISTS device_approximate_location TEXT;
