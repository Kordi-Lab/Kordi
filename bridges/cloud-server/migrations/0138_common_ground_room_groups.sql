-- Common ground room groups: a group chat started from a room, and the
-- invitations it sent to room members who are not the creator's contacts.

CREATE TABLE IF NOT EXISTS cloud_common_ground_room_groups (
    group_space_id  TEXT PRIMARY KEY,
    room_id         UUID NOT NULL REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL,
    name            TEXT NOT NULL,
    created_by      TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_groups_room
    ON cloud_common_ground_room_groups (room_id, created_at);

-- One row per invited room member. The group invitation it points at decides
-- whether it is still live; `accepted_at` is set when the invitee joins.
CREATE TABLE IF NOT EXISTS cloud_common_ground_room_invitations (
    invitation_ref      TEXT PRIMARY KEY,
    room_id             UUID NOT NULL REFERENCES cloud_common_ground_rooms(room_id) ON DELETE CASCADE,
    group_space_id      TEXT NOT NULL,
    group_invitation_id TEXT NOT NULL,
    inviter_account_id  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    invitee_account_id  TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at         TIMESTAMPTZ NULL,
    UNIQUE (group_space_id, invitee_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_common_ground_room_invitations_invitee
    ON cloud_common_ground_room_invitations (invitee_account_id, room_id);
