-- Simulator persistence is initialized explicitly and does not modify product tables.
CREATE TABLE IF NOT EXISTS human_simulator_actors (
    actor_id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    config_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
    messages_sent INTEGER NOT NULL DEFAULT 0 CHECK (messages_sent >= 0),
    owner TEXT,
    lease_until TIMESTAMPTZ
);
