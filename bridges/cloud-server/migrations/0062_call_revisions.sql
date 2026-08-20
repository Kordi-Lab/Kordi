ALTER TABLE cloud_calls
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1);
