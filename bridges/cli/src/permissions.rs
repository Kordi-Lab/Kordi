use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectCapability {
    ViewMembers,
    Ask,
    Debate,
    Broadcast,
    Publish,
    Sync,
    ManageInvites,
    Admin,
}

impl ProjectCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ViewMembers => "view_members",
            Self::Ask => "ask",
            Self::Debate => "debate",
            Self::Broadcast => "broadcast",
            Self::Publish => "publish",
            Self::Sync => "sync",
            Self::ManageInvites => "manage_invites",
            Self::Admin => "admin",
        }
    }
}

pub fn normalized_role(role: Option<&str>) -> &'static str {
    match role.unwrap_or("member").trim() {
        "owner" => "owner",
        "member" => "member",
        "guest" => "guest",
        _ => "member",
    }
}

pub fn is_valid_join_role(role: &str) -> bool {
    matches!(role.trim(), "member" | "guest")
}

pub fn role_has_capability(role: &str, capability: ProjectCapability) -> bool {
    match normalized_role(Some(role)) {
        "owner" => true,
        "member" => matches!(
            capability,
            ProjectCapability::ViewMembers
                | ProjectCapability::Ask
                | ProjectCapability::Debate
                | ProjectCapability::Broadcast
                | ProjectCapability::Publish
                | ProjectCapability::Sync
        ),
        "guest" => matches!(
            capability,
            ProjectCapability::ViewMembers | ProjectCapability::Ask
        ),
        _ => false,
    }
}

pub fn role_capabilities(role: Option<&str>) -> Vec<String> {
    let role = normalized_role(role);
    let all = [
        ProjectCapability::ViewMembers,
        ProjectCapability::Ask,
        ProjectCapability::Debate,
        ProjectCapability::Broadcast,
        ProjectCapability::Publish,
        ProjectCapability::Sync,
        ProjectCapability::ManageInvites,
        ProjectCapability::Admin,
    ];
    all.into_iter()
        .filter(|capability| role_has_capability(role, *capability))
        .map(|capability| capability.as_str().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_has_admin_capabilities() {
        assert!(role_has_capability(
            "owner",
            ProjectCapability::ManageInvites
        ));
        assert!(role_has_capability("owner", ProjectCapability::Admin));
        assert!(role_has_capability("owner", ProjectCapability::Publish));
    }

    #[test]
    fn member_and_guest_capabilities_are_restricted() {
        assert!(role_has_capability("member", ProjectCapability::Broadcast));
        assert!(!role_has_capability(
            "member",
            ProjectCapability::ManageInvites
        ));
        assert!(role_has_capability("guest", ProjectCapability::Ask));
        assert!(!role_has_capability("guest", ProjectCapability::Broadcast));
        assert!(!role_has_capability("guest", ProjectCapability::Publish));
    }

    #[test]
    fn join_role_validation_rejects_owner_escalation() {
        assert!(is_valid_join_role("member"));
        assert!(is_valid_join_role("guest"));
        assert!(!is_valid_join_role("owner"));
        assert!(!is_valid_join_role("admin"));
    }
}
