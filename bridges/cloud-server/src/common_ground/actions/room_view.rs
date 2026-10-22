//! Groups started from a room and the viewer's pending invitations to them,
//! shown with the room and its results.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::common_ground::people::person;

type GroupRow = (
    String,
    Uuid,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    i64,
    bool,
);

/// People a group row shows.
const MAX_SHOWN_MEMBERS: usize = 8;

/// The active people in each conversation, creator first, then by join
/// order, at most [`MAX_SHOWN_MEMBERS`] each. Service accounts are left out.
async fn group_members(
    pool: &PgPool,
    conversations: &[Uuid],
    service: &[String],
) -> sqlx_core::Result<HashMap<Uuid, Vec<Value>>> {
    let rows: Vec<(Uuid, String, Option<String>, Option<String>)> = query_as(
        "SELECT member.conversation_id, member.account_id, account.display_name, account.avatar_url
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.conversation_id = member.conversation_id
         WHERE member.conversation_id = ANY($1) AND member.membership_state = 'active'
           AND NOT (member.account_id = ANY($2))
         ORDER BY member.conversation_id, member.account_id = room_group.created_by DESC,
                  member.joined_at, member.account_id",
    )
    .bind(conversations)
    .bind(service)
    .fetch_all(pool)
    .await?;
    let mut out: HashMap<Uuid, Vec<Value>> = HashMap::new();
    for (conversation, account, name, avatar) in rows {
        let shown = out.entry(conversation).or_default();
        if shown.len() < MAX_SHOWN_MEMBERS {
            shown.push(person(&account, name.as_deref(), avatar.as_deref()));
        }
    }
    Ok(out)
}

type InvitationRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
);

/// `(groups, invitations)` for `viewer` in this room.
pub(in crate::common_ground) async fn room_extras(
    pool: &PgPool,
    room_id: Uuid,
    viewer: &str,
) -> sqlx_core::Result<(Value, Value)> {
    let service = crate::system_account::service_account_ids();
    let groups: Vec<GroupRow> = query_as(
        "SELECT room_group.group_space_id, room_group.conversation_id, room_group.name,
                room_group.topic, room_group.created_by, account.display_name, account.avatar_url,
                (SELECT COUNT(*) FROM cloud_chat_conversation_members member
                 WHERE member.conversation_id = room_group.conversation_id
                   AND member.membership_state = 'active' AND NOT (member.account_id = ANY($3))),
                EXISTS(SELECT 1 FROM cloud_chat_conversation_members member
                       WHERE member.conversation_id = room_group.conversation_id
                         AND member.account_id = $2 AND member.membership_state = 'active')
         FROM cloud_common_ground_room_groups room_group
         JOIN cloud_accounts account ON account.account_id = room_group.created_by
         WHERE room_group.room_id = $1
         ORDER BY room_group.created_at, room_group.group_space_id",
    )
    .bind(room_id)
    .bind(viewer)
    .bind(&service)
    .fetch_all(pool)
    .await?;
    let conversations: Vec<Uuid> = groups.iter().map(|row| row.1).collect();
    let mut members = group_members(pool, &conversations, &service).await?;
    let groups: Vec<Value> = groups
        .into_iter()
        .map(
            |(space, conversation, name, topic, creator, creator_name, avatar, count, joined)| {
                json!({
                    "groupSpaceId": space,
                    "conversationId": conversation,
                    "name": name,
                    "topic": topic,
                    "members": members.remove(&conversation).unwrap_or_default(),
                    "memberCount": count,
                    "createdBy": person(&creator, creator_name.as_deref(), avatar.as_deref()),
                    "joined": joined,
                })
            },
        )
        .collect();
    // Group invitations keep their expiry as RFC 3339 text in UTC.
    let invitations: Vec<InvitationRow> = query_as(
        "SELECT invite.invitation_ref, invite.group_space_id, room_group.name,
                invite.inviter_account_id, account.display_name, account.avatar_url,
                invite.created_at
         FROM cloud_common_ground_room_invitations invite
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.group_space_id = invite.group_space_id
         JOIN cloud_group_invitations group_invite
           ON group_invite.invitation_id = invite.group_invitation_id
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id
         WHERE invite.room_id = $1 AND invite.invitee_account_id = $2
           AND invite.accepted_at IS NULL
           AND group_invite.revoked_at IS NULL AND group_invite.expires_at > $3
         ORDER BY invite.created_at DESC",
    )
    .bind(room_id)
    .bind(viewer)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await?;
    let invitations: Vec<Value> = invitations
        .into_iter()
        .map(
            |(reference, space, name, from, from_name, avatar, created_at)| {
                json!({
                    "invitationRef": reference,
                    "groupSpaceId": space,
                    "name": name,
                    "from": person(&from, from_name.as_deref(), avatar.as_deref()),
                    "createdAt": created_at,
                })
            },
        )
        .collect();
    Ok((json!(groups), json!(invitations)))
}
