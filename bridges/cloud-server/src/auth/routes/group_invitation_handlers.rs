use super::*;
use rand::RngCore;
use sha2::{Digest, Sha256};

mod acceptance;
mod creation;
mod lookup;

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

fn syncable_cloud_avatar_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return None;
    }
    (value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("data:image/png;base64,")
        || value.starts_with("data:image/jpeg;base64,")
        || value.starts_with("data:image/webp;base64,"))
    .then(|| value.to_string())
}

fn group_invitation_has_capacity(snapshot: &GroupInvitationSnapshot) -> bool {
    snapshot.participants.len() < GROUP_INVITE_MAX_MEMBERS
}

#[cfg(test)]
mod tests;
