CREATE TABLE cloud_calls (
    call_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    created_by_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    client_operation_id UUID NOT NULL,
    call_kind TEXT NOT NULL CHECK (call_kind IN ('voice', 'video', 'meeting')),
    call_state TEXT NOT NULL CHECK (call_state IN ('ringing', 'active', 'ended')),
    room_name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    UNIQUE (created_by_account_id, client_operation_id)
);

CREATE UNIQUE INDEX cloud_calls_one_open_per_conversation
    ON cloud_calls(conversation_id)
    WHERE ended_at IS NULL;

CREATE INDEX cloud_calls_conversation_history
    ON cloud_calls(conversation_id, created_at DESC);

CREATE TABLE cloud_call_participants (
    call_id UUID NOT NULL REFERENCES cloud_calls(call_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    participant_state TEXT NOT NULL CHECK (participant_state IN ('invited', 'joined', 'declined', 'left')),
    invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    PRIMARY KEY (call_id, account_id)
);

CREATE INDEX cloud_call_participants_account
    ON cloud_call_participants(account_id, invited_at DESC);

CREATE TABLE cloud_voip_push_tokens (
    device_id TEXT PRIMARY KEY REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_token TEXT NOT NULL,
    apns_environment TEXT NOT NULL CHECK (apns_environment IN ('development', 'production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_token, apns_environment)
);

CREATE INDEX cloud_voip_push_tokens_account
    ON cloud_voip_push_tokens(account_id, updated_at DESC);

CREATE TABLE cloud_apns_push_tokens (
    device_id TEXT PRIMARY KEY REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_token TEXT NOT NULL,
    apns_environment TEXT NOT NULL CHECK (apns_environment IN ('development', 'production')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (device_token, apns_environment)
);

CREATE INDEX cloud_apns_push_tokens_account
    ON cloud_apns_push_tokens(account_id, updated_at DESC);
