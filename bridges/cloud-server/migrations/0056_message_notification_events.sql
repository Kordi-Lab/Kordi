ALTER TABLE cloud_apns_push_tokens
    ADD COLUMN message_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN message_sound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN message_previews_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN message_badge_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE cloud_message_notification_events (
    recipient_account_id TEXT NOT NULL
        REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    message_id UUID NOT NULL
        REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL
        REFERENCES cloud_chat_conversations(conversation_id) ON DELETE CASCADE,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (recipient_account_id, message_id)
);

CREATE INDEX cloud_message_notification_events_pending
    ON cloud_message_notification_events(created_at)
    WHERE accepted_at IS NULL;
