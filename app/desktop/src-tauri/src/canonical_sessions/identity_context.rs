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
    pub allowed_targets: Vec<String>,
    pub reach_out_allowed: bool,
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
    let mut rendered = String::new();
    rendered.push_str("<multi_participant_identity_context version=\"v1\">\n");
    rendered.push_str("Stable identity/collaboration frame. Treat canonical identity IDs as authoritative; display names are descriptive only.\n");
    rendered.push_str("Rules:\n");
    rendered.push_str("- mayImpersonate: none\n");
    rendered.push_str("- Do not impersonate people or agents other than the replyAs identity.\n");
    rendered.push_str("- Do not prefix assistant replies with speaker labels or identity names.\n");
    rendered.push_str("- Recent messages, request text, and user-specific context must appear outside this stable preamble and after identity metadata.\n");
    rendered.push_str("- Do not add padding or synthetic text for prompt caching thresholds.\n");

    let has_session_metadata = input
        .session_id
        .as_ref()
        .and_then(|value| clean(value))
        .is_some()
        || input
            .session_kind
            .as_ref()
            .and_then(|value| clean(value))
            .is_some()
        || input
            .project_name
            .as_ref()
            .and_then(|value| clean(value))
            .is_some();
    if has_session_metadata {
        rendered.push_str("Session metadata:\n");
        push_optional_line(&mut rendered, "sessionId", input.session_id.as_deref());
        push_optional_line(&mut rendered, "sessionKind", input.session_kind.as_deref());
        push_optional_line(&mut rendered, "projectName", input.project_name.as_deref());
    }

    rendered.push_str("Current model/self:\n");
    push_role(&mut rendered, &input.self_identity);

    rendered.push_str("Requester / initiator:\n");
    if let Some(requester) = input.requester.as_ref() {
        push_role(&mut rendered, requester);
    } else {
        rendered.push_str("- none\n");
    }

    rendered.push_str("Current target:\n");
    if let Some(target) = input.target.as_ref() {
        push_role(&mut rendered, target);
    } else {
        rendered.push_str("- none\n");
    }

    rendered.push_str("Session participants:\n");
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
        rendered.push_str("- none\n");
    } else {
        for participant in &participants {
            push_participant(&mut rendered, participant);
        }
    }

    rendered.push_str("Permissions:\n");
    push_permissions(&mut rendered, &input.permissions);
    rendered.push_str("</multi_participant_identity_context>\n");
    rendered
}

fn push_role(rendered: &mut String, role: &IdentityContextRole) {
    push_line(rendered, "identityId", &role.identity_id);
    push_line(rendered, "displayName", &role.display_name);
    push_line(rendered, "kind", &role.kind);
    if let Some(owner) = owner_label(
        role.owner_display_name.as_deref(),
        role.owner_identity_id.as_deref(),
    ) {
        rendered.push_str("- owner: ");
        rendered.push_str(&owner);
        rendered.push('\n');
    }
    push_optional_line(rendered, "locality", role.locality.as_deref());
}

fn push_participant(rendered: &mut String, participant: &IdentityContextParticipant) {
    rendered.push_str("- ");
    rendered.push_str(&clean_required(&participant.identity_id));
    rendered.push_str(" | ");
    rendered.push_str(&clean_required(&participant.display_name));
    rendered.push_str(" | ");
    rendered.push_str(&clean_required(&participant.kind));

    if let Some(role) = clean(&participant.role) {
        rendered.push_str(" | role: ");
        rendered.push_str(&role);
    }
    if let Some(owner) = owner_label(
        participant.owner_display_name.as_deref(),
        participant.owner_identity_id.as_deref(),
    ) {
        rendered.push_str(" | owner: ");
        rendered.push_str(&owner);
    }
    push_optional_field(
        rendered,
        "bridgeNodeId",
        participant.bridge_node_id.as_deref(),
    );
    push_optional_field(rendered, "humanId", participant.human_id.as_deref());
    push_optional_field(rendered, "agentId", participant.agent_id.as_deref());
    push_optional_field(rendered, "runtime", participant.runtime.as_deref());
    push_optional_field(rendered, "locality", participant.locality.as_deref());
    rendered.push('\n');
}

fn push_permissions(rendered: &mut String, permissions: &IdentityContextPermissions) {
    rendered.push_str("- replyAs: ");
    rendered.push_str(&clean_required(&permissions.reply_as_identity_id));
    rendered.push_str(" only\n");

    if permissions.reach_out_allowed
        && !clean_allowed_targets(&permissions.allowed_targets).is_empty()
    {
        rendered.push_str("- reachOut: allowed only for explicit non-local @Person/@Agent mentions in the current user message\n");
    } else {
        rendered.push_str("- reachOut: disabled; ask the local user when a non-local target is ambiguous or not permitted\n");
    }

    rendered.push_str("- allowedTargets: ");
    rendered.push_str(&format_allowed_targets(&permissions.allowed_targets));
    rendered.push('\n');
    rendered.push_str("- mayImpersonate: none\n");
    push_line(rendered, "contextPolicy", &permissions.context_policy);
    rendered.push_str("- requiresApproval: ");
    rendered.push_str(if permissions.requires_approval {
        "true"
    } else {
        "false"
    });
    rendered.push('\n');
}

fn push_line(rendered: &mut String, label: &str, value: &str) {
    rendered.push_str("- ");
    rendered.push_str(label);
    rendered.push_str(": ");
    rendered.push_str(&clean_required(value));
    rendered.push('\n');
}

fn push_optional_line(rendered: &mut String, label: &str, value: Option<&str>) {
    if let Some(value) = value.and_then(clean) {
        rendered.push_str("- ");
        rendered.push_str(label);
        rendered.push_str(": ");
        rendered.push_str(&value);
        rendered.push('\n');
    }
}

fn push_optional_field(rendered: &mut String, label: &str, value: Option<&str>) {
    if let Some(value) = value.and_then(clean) {
        rendered.push_str(" | ");
        rendered.push_str(label);
        rendered.push_str(": ");
        rendered.push_str(&value);
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

fn format_allowed_targets(targets: &[String]) -> String {
    let targets = clean_allowed_targets(targets);
    if targets.is_empty() {
        "[]".to_string()
    } else {
        serde_json::to_string(&targets).expect("serialize allowed targets")
    }
}

fn clean_allowed_targets(targets: &[String]) -> Vec<String> {
    let mut targets: Vec<String> = targets.iter().filter_map(|target| clean(target)).collect();
    targets.sort();
    targets.dedup();
    targets
}

fn clean_required(value: &str) -> String {
    clean(value).unwrap_or_else(|| "<missing required value>".to_string())
}

fn clean(value: &str) -> Option<String> {
    let cleaned = clean_prompt_scalar(value);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn clean_prompt_scalar(value: &str) -> String {
    let mut cleaned = String::new();
    let mut last_was_space = false;

    for character in value.trim().chars() {
        if character.is_control() || character == '|' || character.is_whitespace() {
            if !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
            continue;
        }

        match character {
            '<' => cleaned.push_str("&lt;"),
            '>' => cleaned.push_str("&gt;"),
            _ => cleaned.push(character),
        }
        last_was_space = false;
    }

    cleaned.trim().to_string()
}
