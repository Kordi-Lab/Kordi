CREATE TABLE cloud_chat_attachment_reactions (
    message_id UUID NOT NULL,
    attachment_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    reaction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (message_id, attachment_id, account_id, reaction),
    FOREIGN KEY (message_id, attachment_id)
        REFERENCES cloud_chat_message_attachments(message_id, attachment_id) ON DELETE CASCADE
);

-- Keep private tombstones after an attachment is removed globally so replaying
-- an older sync event can never make a privately hidden photo visible again.
CREATE TABLE cloud_chat_attachment_visibility (
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES cloud_chat_messages(message_id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, message_id, attachment_id)
);
