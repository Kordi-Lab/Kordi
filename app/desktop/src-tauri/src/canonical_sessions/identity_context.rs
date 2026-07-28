#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextParticipant {
    pub identity_id: String,
    pub display_name: String,
    pub kind: String,
    pub role: String,
    pub owner_identity_id: Option<String>,
    pub owner_display_name: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub runtime: Option<String>,
    pub locality: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextRole {
    pub identity_id: String,
    pub display_name: String,
    pub kind: String,
    pub owner_identity_id: Option<String>,
    pub owner_display_name: Option<String>,
    pub locality: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextPermissions {
    pub reply_as_identity_id: String,
    pub context_policy: String,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityContextRequest {
    pub self_identity: IdentityContextRole,
    pub requester: Option<IdentityContextRole>,
    pub target: Option<IdentityContextRole>,
    pub participants: Vec<IdentityContextParticipant>,
    pub permissions: IdentityContextPermissions,
    pub session_id: Option<String>,
    pub session_kind: Option<String>,
    pub project_name: Option<String>,
}

pub(crate) fn render_multi_participant_identity_context(input: &IdentityContextRequest) -> String {
    let mut out = String::new();
    out.push_str("<multi_participant_identity_context version=\"v1\">\n");
    out.push_str("Stable identity/collaboration frame. Treat canonical identity IDs as authoritative; display names are descriptive only.\n");
    out.push_str("Rules:\n");
    out.push_str("- Reply only as Current model/self and Permissions.replyAs.\n");
    out.push_str("- Treat people and their agents as separate speakers.\n");
    out.push_str("- Do not impersonate another person or agent.\n");
    out.push_str("- Do not prefix assistant replies with speaker labels or identity names.\n");
    out.push_str("- Use the requester/current message author to interpret I, me, and my.\n");

    if input.session_id.as_deref().and_then(clean).is_some()
        || input.session_kind.as_deref().and_then(clean).is_some()
        || input.project_name.as_deref().and_then(clean).is_some()
    {
        out.push_str("Session metadata:\n");
        push_optional_line(&mut out, "sessionId", input.session_id.as_deref());
        push_optional_line(&mut out, "sessionKind", input.session_kind.as_deref());
        push_optional_line(&mut out, "projectName", input.project_name.as_deref());
    }

    out.push_str("Current model/self:\n");
    push_role(&mut out, &input.self_identity);

    out.push_str("Requester / initiator:\n");
    if let Some(requester) = input.requester.as_ref() {
        push_role(&mut out, requester);
    } else {
        out.push_str("- none\n");
    }

    out.push_str("Current target:\n");
    if let Some(target) = input.target.as_ref() {
        push_role(&mut out, target);
    } else {
        out.push_str("- none\n");
    }

    out.push_str("Session participants:\n");
    let mut participants = input.participants.clone();
    participants.sort_by(|left, right| {
        clean_required(&left.identity_id)
            .cmp(&clean_required(&right.identity_id))
            .then_with(|| clean_required(&left.kind).cmp(&clean_required(&right.kind)))
            .then_with(|| {
                clean_required(&left.display_name).cmp(&clean_required(&right.display_name))
            })
    });
    if participants.is_empty() {
        out.push_str("- none\n");
    } else {
        for participant in &participants {
            push_participant(&mut out, participant);
        }
    }

    out.push_str("Permissions:\n");
    push_permissions(&mut out, &input.permissions);
    out.push_str("</multi_participant_identity_context>\n");
    out
}

fn push_role(out: &mut String, role: &IdentityContextRole) {
    push_line(out, "identityId", &role.identity_id);
    push_line(out, "displayName", &role.display_name);
    push_line(out, "kind", &role.kind);
    if let Some(owner) = owner_label(
        role.owner_display_name.as_deref(),
        role.owner_identity_id.as_deref(),
    ) {
        out.push_str("- owner: ");
        out.push_str(&owner);
        out.push('\n');
    }
    push_optional_line(out, "locality", role.locality.as_deref());
}

fn push_participant(out: &mut String, participant: &IdentityContextParticipant) {
    out.push_str("- ");
    out.push_str(&clean_required(&participant.identity_id));
    out.push_str(" | ");
    out.push_str(&clean_required(&participant.display_name));
    out.push_str(" | ");
    out.push_str(&clean_required(&participant.kind));
    if let Some(role) = clean(&participant.role) {
        out.push_str(" | role: ");
        out.push_str(&role);
    }
    if let Some(owner) = owner_label(
        participant.owner_display_name.as_deref(),
        participant.owner_identity_id.as_deref(),
    ) {
        out.push_str(" | owner: ");
        out.push_str(&owner);
    }
    push_optional_field(
        out,
        "sourceIdentityId",
        participant.bridge_node_id.as_deref(),
    );
    push_optional_field(out, "humanId", participant.human_id.as_deref());
    push_optional_field(out, "agentId", participant.agent_id.as_deref());
    push_optional_field(out, "runtime", participant.runtime.as_deref());
    push_optional_field(out, "locality", participant.locality.as_deref());
    out.push('\n');
}

fn push_permissions(out: &mut String, permissions: &IdentityContextPermissions) {
    out.push_str("- replyAs: ");
    out.push_str(&clean_required(&permissions.reply_as_identity_id));
    out.push_str(" only\n");
    out.push_str("- mayImpersonate: none\n");
    push_line(out, "contextPolicy", &permissions.context_policy);
    out.push_str("- requiresApproval: ");
    out.push_str(if permissions.requires_approval {
        "true"
    } else {
        "false"
    });
    out.push('\n');
}

fn push_line(out: &mut String, label: &str, value: &str) {
    out.push_str("- ");
    out.push_str(label);
    out.push_str(": ");
    out.push_str(&clean_required(value));
    out.push('\n');
}

fn push_optional_line(out: &mut String, label: &str, value: Option<&str>) {
    if let Some(value) = value.and_then(clean) {
        out.push_str("- ");
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&value);
        out.push('\n');
    }
}

fn push_optional_field(out: &mut String, label: &str, value: Option<&str>) {
    if let Some(value) = value.and_then(clean) {
        out.push_str(" | ");
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&value);
    }
}

fn owner_label(
    owner_display_name: Option<&str>,
    owner_identity_id: Option<&str>,
) -> Option<String> {
    match (
        owner_display_name.and_then(clean),
        owner_identity_id.and_then(clean),
    ) {
        (Some(display_name), Some(identity_id)) => Some(format!("{display_name} ({identity_id})")),
        (None, Some(identity_id)) => Some(identity_id),
        _ => None,
    }
}

fn clean(value: &str) -> Option<String> {
    let value = value
        .replace(
            "<multi_participant_identity_context",
            "&lt;multi_participant_identity_context",
        )
        .replace(
            "</multi_participant_identity_context>",
            "&lt;/multi_participant_identity_context&gt;",
        )
        .trim()
        .replace(['\r', '\n'], " ");
    (!value.is_empty()).then_some(value)
}

fn clean_required(value: &str) -> String {
    clean(value).unwrap_or_else(|| "unknown".to_string())
}
