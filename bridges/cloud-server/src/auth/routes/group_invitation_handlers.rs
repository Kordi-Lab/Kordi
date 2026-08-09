use super::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

mod acceptance;
mod creation;
mod lookup;

#[cfg(test)]
use acceptance::accepted_group_control_body;
pub(super) use acceptance::{accept_group_invitation, revoke_group_invitation};
pub(super) use creation::{
    create_group_invitation, get_group_invitation, group_invitation_landing,
    list_active_group_invitations,
};
use lookup::*;

const GROUP_INVITE_TOKEN_PREFIX: &str = "kordi_gi_";
const GROUP_INVITE_LIFETIME_DAYS: i64 = 7;
const GROUP_INVITE_MAX_MEMBERS: usize = 50;
const GROUP_INVITE_MAX_TITLE_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct GroupInvitationParticipant {
    account_id: String,
    display_name: String,
    avatar_url: Option<String>,
    role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupInvitationSnapshot {
    group_id: String,
    group_space_id: String,
    group_title: String,
    created_by_account_id: String,
    participants: Vec<GroupInvitationParticipant>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGroupControlEnvelope {
    kind: String,
    group_id: String,
    group_space_id: Option<String>,
    group_title: Option<String>,
    created_by_account_id: String,
    actor: GroupInvitationParticipant,
    #[serde(default)]
    participants: Vec<GroupInvitationParticipant>,
}

struct GroupInvitationRecord {
    invitation_id: String,
    inviter_account_id: String,
    inviter_display_name: Option<String>,
    inviter_public_account_number: i64,
    inviter_avatar_url: Option<String>,
    snapshot: GroupInvitationSnapshot,
    expires_at: String,
}

enum GroupInvitationLookup {
    Valid(Box<GroupInvitationRecord>),
    Invalid,
    Expired,
}

type GroupInvitationRow = (
    String,
    String,
    Option<String>,
    i64,
    Option<String>,
    serde_json::Value,
    String,
);

fn new_group_invite_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!(
        "{}{}",
        GROUP_INVITE_TOKEN_PREFIX,
        URL_SAFE_NO_PAD.encode(bytes)
    )
}

fn hash_group_invite_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

fn group_invite_url(token: &str) -> String {
    let public_base =
        std::env::var("KORDI_PUBLIC_APP_URL").unwrap_or_else(|_| "https://kordi.ai".to_string());
    format!("{}/g/{token}", public_base.trim_end_matches('/'))
}

fn group_invite_deep_link(token: &str) -> String {
    format!("kordi://group-invite/{token}")
}

fn clean_group_title(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > GROUP_INVITE_MAX_TITLE_CHARS {
        return None;
    }
    Some(value.to_string())
}

fn clean_participant(
    mut participant: GroupInvitationParticipant,
) -> Option<GroupInvitationParticipant> {
    participant.account_id = participant.account_id.trim().to_string();
    if !is_cloud_account_id(&participant.account_id) {
        return None;
    }
    participant.display_name = participant.display_name.trim().chars().take(80).collect();
    if participant.display_name.is_empty() {
        participant.display_name = "Kordi member".to_string();
    }
    participant.avatar_url = participant
        .avatar_url
        .as_deref()
        .and_then(syncable_cloud_avatar_url);
    participant.role = match participant.role.trim() {
        "admin" => "admin",
        "self" => "self",
        _ => "person",
    }
    .to_string();
    Some(participant)
}

fn parse_group_control_for_invitation(body: &str) -> Option<StoredGroupControlEnvelope> {
    let encoded = body.trim().strip_prefix(CLOUD_GROUP_CONTROL_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn invitation_snapshot_from_control(
    body: &str,
    message_sender_account_id: &str,
    requested_group_id: &str,
    requested_group_space_id: &str,
    requested_group_title: &str,
) -> Option<GroupInvitationSnapshot> {
    let control = parse_group_control_for_invitation(body)?;
    if ![
        "group-invite",
        "group-message",
        "group-update",
        "group-title-update",
        "session-title-update",
    ]
    .contains(&control.kind.as_str())
        || control.group_id.trim() != requested_group_id
        || control
            .group_space_id
            .as_deref()
            .unwrap_or(control.group_id.as_str())
            .trim()
            != requested_group_space_id
        || control.actor.account_id.trim() != message_sender_account_id
    {
        return None;
    }

    let actor = clean_participant(control.actor)?;
    let mut participants_by_account = HashMap::new();
    participants_by_account.insert(actor.account_id.clone(), actor);
    for participant in control.participants {
        let Some(participant) = clean_participant(participant) else {
            continue;
        };
        participants_by_account
            .entry(participant.account_id.clone())
            .or_insert(participant);
    }
    if participants_by_account.len() < 2 || participants_by_account.len() > GROUP_INVITE_MAX_MEMBERS
    {
        return None;
    }

    let created_by_account_id = control.created_by_account_id.trim().to_string();
    if !is_cloud_account_id(&created_by_account_id) {
        return None;
    }
    let mut participants = participants_by_account.into_values().collect::<Vec<_>>();
    participants.sort_by(|left, right| left.account_id.cmp(&right.account_id));
    let group_title = control
        .group_title
        .as_deref()
        .and_then(clean_group_title)
        .unwrap_or_else(|| requested_group_title.to_string());
    Some(GroupInvitationSnapshot {
        group_id: requested_group_id.to_string(),
        group_space_id: requested_group_space_id.to_string(),
        group_title,
        created_by_account_id,
        participants,
    })
}

fn snapshot_allows_group_invitation(
    snapshot: &GroupInvitationSnapshot,
    inviter_account_id: &str,
) -> bool {
    inviter_account_id == snapshot.created_by_account_id
        || snapshot.participants.iter().any(|participant| {
            participant.account_id == inviter_account_id && participant.role == "admin"
        })
}

fn group_invitation_has_capacity(snapshot: &GroupInvitationSnapshot) -> bool {
    snapshot.participants.len() < GROUP_INVITE_MAX_MEMBERS
}

#[cfg(test)]
mod tests;
