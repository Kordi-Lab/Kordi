use rusqlite::{params, Connection};

use super::schema::ensure_local_profile;
use super::{
    open_db, render_multi_participant_identity_context, select_identity, select_session,
    IdentityContextParticipant, IdentityContextPermissions, IdentityContextRequest,
    IdentityContextRole,
};

fn truncate_context_line(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim().replace(['\r', '\n'], " ");
    if trimmed.chars().count() <= max_chars {
        return trimmed;
    }
    if max_chars == 0 {
        return String::new();
    }
    let mut truncated = trimmed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    truncated.push('…');
    truncated
}

#[derive(Debug, Clone)]
struct PromptParticipantRow {
    identity_id: String,
    display_name: String,
    kind: String,
    role: String,
    owner_identity_id: Option<String>,
    owner_display_name: Option<String>,
    bridge_node_id: Option<String>,
    human_id: Option<String>,
    agent_id: Option<String>,
    source: String,
    metadata_json: Option<String>,
}

impl PromptParticipantRow {
    fn is_bridge_source(&self) -> bool {
        self.source.trim().eq_ignore_ascii_case("bridge")
    }

    fn is_local_source(&self) -> bool {
        self.source.trim().is_empty() || self.source.trim().eq_ignore_ascii_case("local")
    }

    fn to_identity_context_participant(&self) -> IdentityContextParticipant {
        let include_transport_ids = self.is_bridge_source();
        IdentityContextParticipant {
            identity_id: self.identity_id.clone(),
            display_name: self.display_name.clone(),
            kind: self.kind.clone(),
            role: identity_frame_role(&self.role),
            owner_identity_id: self.owner_identity_id.clone(),
            owner_display_name: self.owner_display_name.clone(),
            bridge_node_id: include_transport_ids
                .then(|| self.bridge_node_id.clone())
                .flatten(),
            human_id: include_transport_ids
                .then(|| self.human_id.clone())
                .flatten(),
            agent_id: include_transport_ids
                .then(|| self.agent_id.clone())
                .flatten(),
            runtime: runtime_from_metadata(self.metadata_json.as_deref()),
            locality: locality_from_source(&self.source),
        }
    }

    fn to_identity_context_role(&self) -> IdentityContextRole {
        IdentityContextRole {
            identity_id: self.identity_id.clone(),
            display_name: self.display_name.clone(),
            kind: self.kind.clone(),
            owner_identity_id: self.owner_identity_id.clone(),
            owner_display_name: self.owner_display_name.clone(),
            locality: locality_from_source(&self.source),
        }
    }
}

fn identity_frame_role(role: &str) -> String {
    let role = role.trim();
    if matches!(role, "" | "self" | "person" | "delegate") {
        String::new()
    } else {
        role.to_string()
    }
}

fn runtime_from_metadata(metadata_json: Option<&str>) -> Option<String> {
    let metadata = metadata_json
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let value = serde_json::from_str::<serde_json::Value>(metadata).ok()?;
    for key in ["runtime", "runtimeLabel", "delegateAgentName"] {
        if let Some(value) = value.get(key).and_then(|value| value.as_str()) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn locality_from_source(source: &str) -> Option<String> {
    if source.trim().eq_ignore_ascii_case("bridge") {
        Some("non-local".to_string())
    } else if source.trim().eq_ignore_ascii_case("local") {
        Some("local".to_string())
    } else {
        None
    }
}

fn session_participant_rows(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<PromptParticipantRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.display_name, i.kind, sp.role, owner.id, owner.display_name,
                    i.bridge_node_id, i.human_id, i.agent_id, i.source, i.metadata_json
             FROM session_participants sp
             JOIN identities i ON i.id = sp.identity_id
             LEFT JOIN identities owner ON owner.id = i.owner_identity_id
             WHERE sp.session_id = ?1
               AND sp.state = 'active'
             ORDER BY sp.added_at_ms ASC, i.display_name ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(PromptParticipantRow {
                identity_id: row.get(0)?,
                display_name: row.get(1)?,
                kind: row.get(2)?,
                role: row.get(3)?,
                owner_identity_id: row.get(4)?,
                owner_display_name: row.get(5)?,
                bridge_node_id: row.get(6)?,
                human_id: row.get(7)?,
                agent_id: row.get(8)?,
                source: row.get(9)?,
                metadata_json: row.get(10)?,
            })
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    Ok(rows)
}

fn recent_session_message_lines(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1
               AND TRIM(m.content_text) <> ''
             ORDER BY m.sequence_num DESC, m.created_at_ms DESC
             LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let mut messages = stmt
        .query_map(params![session_id, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    messages.reverse();
    Ok(messages
        .into_iter()
        .map(|(sender, role, text)| {
            format!("{} ({role}): {}", sender, truncate_context_line(&text, 700))
        })
        .collect())
}

fn push_recent_session_messages(lines: &mut Vec<String>, messages: Vec<String>) {
    if !messages.is_empty() {
        lines.push(String::new());
        lines.push("Recent session messages:".to_string());
        lines.extend(messages);
    }
}

fn identity_role_for_id(
    conn: &Connection,
    participants: &[PromptParticipantRow],
    identity_id: Option<&str>,
) -> Result<Option<IdentityContextRole>, String> {
    let Some(identity_id) = identity_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if let Some(participant) = participants
        .iter()
        .find(|participant| participant.identity_id == identity_id)
    {
        return Ok(Some(participant.to_identity_context_role()));
    }
    let Some(identity) = select_identity(conn, identity_id)? else {
        return Ok(None);
    };
    let owner = match identity.owner_identity_id.as_deref() {
        Some(owner_id) => select_identity(conn, owner_id)?,
        None => None,
    };
    Ok(Some(IdentityContextRole {
        identity_id: identity.id,
        display_name: identity.display_name,
        kind: identity.kind,
        owner_identity_id: identity.owner_identity_id,
        owner_display_name: owner.map(|owner| owner.display_name),
        locality: locality_from_source(&identity.source),
    }))
}

fn participant_is_local_self_agent(
    participant: &PromptParticipantRow,
    profile_human_identity_id: Option<&str>,
    active_agent_identity_id: Option<&str>,
) -> bool {
    if !participant.kind.eq_ignore_ascii_case("agent") || !participant.is_local_source() {
        return false;
    }
    participant.role.trim().eq_ignore_ascii_case("self")
        || profile_human_identity_id.is_some_and(|identity_id| {
            participant.owner_identity_id.as_deref() == Some(identity_id)
        })
        || active_agent_identity_id
            .is_some_and(|identity_id| participant.identity_id == identity_id)
}

fn local_self_role(
    conn: &Connection,
    participants: &[PromptParticipantRow],
    primary_identity_id: Option<&str>,
) -> Result<IdentityContextRole, String> {
    let profile = ensure_local_profile(conn)?;
    let profile_human_identity_id = profile.human_identity_id.as_deref();
    let active_agent_identity_id = profile.active_agent_identity_id.as_deref();

    for candidate in [primary_identity_id, active_agent_identity_id] {
        if let Some(role) = identity_role_for_id(conn, participants, candidate)? {
            if role.kind.eq_ignore_ascii_case("agent")
                && role
                    .owner_identity_id
                    .as_deref()
                    .is_none_or(|owner_id| Some(owner_id) == profile_human_identity_id)
            {
                return Ok(role);
            }
        }
    }
    if let Some(participant) = participants.iter().find(|participant| {
        participant_is_local_self_agent(
            participant,
            profile_human_identity_id,
            active_agent_identity_id,
        )
    }) {
        return Ok(participant.to_identity_context_role());
    }
    Ok(IdentityContextRole {
        identity_id: "agent:kordi".to_string(),
        display_name: "Kordi".to_string(),
        kind: "agent".to_string(),
        owner_identity_id: profile.human_identity_id,
        owner_display_name: profile.display_name,
        locality: Some("local".to_string()),
    })
}

fn requester_role(
    conn: &Connection,
    participants: &[PromptParticipantRow],
    created_by_identity_id: &str,
) -> Result<Option<IdentityContextRole>, String> {
    if let Some(role) = identity_role_for_id(conn, participants, Some(created_by_identity_id))? {
        return Ok(Some(role));
    }
    let profile = ensure_local_profile(conn)?;
    identity_role_for_id(conn, participants, profile.human_identity_id.as_deref())
}

fn target_role_for_bridge_agent(
    participants: &[PromptParticipantRow],
    agent_display_name: &str,
    owner_name: Option<&str>,
) -> Option<IdentityContextRole> {
    let agent_name = agent_display_name.trim();
    let owner_name = owner_name.map(str::trim).filter(|value| !value.is_empty());
    participants
        .iter()
        .filter(|participant| participant.kind.eq_ignore_ascii_case("agent"))
        .find(|participant| {
            participant.display_name.trim() == agent_name
                && owner_name.is_none_or(|owner| {
                    participant.owner_display_name.as_deref().map(str::trim) == Some(owner)
                })
        })
        .or_else(|| {
            participants.iter().find(|participant| {
                participant.kind.eq_ignore_ascii_case("agent")
                    && participant.display_name.trim() == agent_name
            })
        })
        .map(PromptParticipantRow::to_identity_context_role)
}

fn unresolved_bridge_agent_target_role(
    agent_display_name: &str,
    owner_name: Option<&str>,
) -> IdentityContextRole {
    let display_name = agent_display_name.trim();
    let display_name = if display_name.is_empty() {
        "Kordi"
    } else {
        display_name
    };
    IdentityContextRole {
        identity_id: "unknown:bridge-agent-target".to_string(),
        display_name: display_name.to_string(),
        kind: "agent".to_string(),
        owner_identity_id: owner_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|_| "unknown:bridge-agent-target-owner".to_string()),
        owner_display_name: owner_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        locality: Some("non-local".to_string()),
    }
}

fn identity_permissions(
    reply_as_identity_id: &str,
    participants: &[PromptParticipantRow],
    context_policy: &str,
) -> IdentityContextPermissions {
    let allowed_targets = participants
        .iter()
        .filter(|participant| participant.identity_id != reply_as_identity_id)
        .filter(|participant| participant.is_bridge_source())
        .map(|participant| participant.identity_id.clone())
        .collect();
    IdentityContextPermissions {
        reply_as_identity_id: reply_as_identity_id.to_string(),
        reach_out_allowed: !participants.is_empty(),
        allowed_targets,
        context_policy: context_policy.to_string(),
        requires_approval: false,
    }
}

fn should_render_identity_frame(
    participants: &[PromptParticipantRow],
    session_kind: &str,
    project_id: Option<&str>,
    project_name: Option<&str>,
) -> bool {
    participants.len() > 2
        || participants
            .iter()
            .any(PromptParticipantRow::is_bridge_source)
        || session_kind.eq_ignore_ascii_case("group")
        || session_kind.eq_ignore_ascii_case("project")
        || project_id.is_some_and(|value| !value.trim().is_empty())
        || project_name.is_some_and(|value| !value.trim().is_empty())
}

fn push_concise_participants(lines: &mut Vec<String>, participants: &[PromptParticipantRow]) {
    if participants.is_empty() {
        return;
    }
    lines.push(String::new());
    lines.push("Session participants:".to_string());
    for participant in participants.iter().take(12) {
        let owner_suffix = participant
            .owner_display_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|owner| format!(", owner: {owner}"))
            .unwrap_or_default();
        lines.push(format!(
            "- {} ({}, {}{})",
            participant.display_name, participant.kind, participant.role, owner_suffix
        ));
    }
}

pub(crate) fn local_agent_session_prompt_context(
    parent_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(session_id) = parent_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let conn = open_db()?;
    let Some(session) = select_session(&conn, session_id)? else {
        return Ok(None);
    };
    let participants = session_participant_rows(&conn, session_id)?;

    let mut lines = Vec::new();
    lines.push(
        "You are Kordi, the user's local agent participating inside this shared Kordi session. When the user mentions @Kordi, answer directly in this same session using the session context below. Do not create or switch sessions. Do not involve bridge participants unless the current user message explicitly mentions a non-local person or agent. Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to."
            .to_string(),
    );

    if should_render_identity_frame(
        &participants,
        &session.kind,
        session.project_id.as_deref(),
        session.project_name.as_deref(),
    ) {
        let self_identity =
            local_self_role(&conn, &participants, session.primary_identity_id.as_deref())?;
        let requester = requester_role(&conn, &participants, &session.created_by_identity_id)?;
        lines.push(String::new());
        lines.push(render_multi_participant_identity_context(
            &IdentityContextRequest {
                permissions: identity_permissions(
                    &self_identity.identity_id,
                    &participants,
                    "recent-window",
                ),
                self_identity,
                requester,
                target: None,
                participants: participants
                    .iter()
                    .map(PromptParticipantRow::to_identity_context_participant)
                    .collect(),
                session_id: Some(session.id.clone()),
                session_kind: Some(session.kind.clone()),
                project_name: session.project_name.clone(),
            },
        ));
    } else {
        push_concise_participants(&mut lines, &participants);
    }

    push_recent_session_messages(
        &mut lines,
        recent_session_message_lines(&conn, session_id, 16)?,
    );

    Ok(Some(lines.join("\n")))
}

pub(crate) fn bridge_agent_parent_session_prompt(
    parent_session_id: Option<&str>,
    agent_display_name: &str,
    owner_name: Option<&str>,
    request_text: &str,
    fallback_context: Option<&str>,
) -> Result<String, String> {
    let agent_name = agent_display_name.trim();
    let agent_name = if agent_name.is_empty() {
        "Kordi"
    } else {
        agent_name
    };
    let request = request_text.trim();
    let mut lines = Vec::new();
    lines.push(format!("You are {agent_name}."));
    if let Some(owner_name) = owner_name.map(str::trim).filter(|value| !value.is_empty()) {
        lines.push(format!("Your owner is {owner_name}."));
    }
    lines.push(
        "You joined this shared Kordi session because someone mentioned you with @Agent. Reply directly to the request using the session context. Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to."
            .to_string(),
    );
    lines.push(
        "If the request asks you to create, manage, persist, search, or close a task, use task_operator so the application records a real task event; do not merely say that you created, found, or closed a task. Use task_operator action=create for task creation, action=search for task lookup, and action=close for task closure. For shared or multi-user tasks, include involvedParticipants with the display names of the people or agents who need to participate in the task."
            .to_string(),
    );

    if let Some(session_id) = parent_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let conn = open_db()?;
        if let Some(session) = select_session(&conn, session_id)? {
            let participants = session_participant_rows(&conn, session_id)?;
            if should_render_identity_frame(
                &participants,
                &session.kind,
                session.project_id.as_deref(),
                session.project_name.as_deref(),
            ) {
                let target = target_role_for_bridge_agent(&participants, agent_name, owner_name)
                    .unwrap_or_else(|| unresolved_bridge_agent_target_role(agent_name, owner_name));
                let requester =
                    requester_role(&conn, &participants, &session.created_by_identity_id)?;
                lines.push(String::new());
                lines.push(render_multi_participant_identity_context(
                    &IdentityContextRequest {
                        permissions: identity_permissions(
                            &target.identity_id,
                            &participants,
                            "request-window",
                        ),
                        self_identity: target.clone(),
                        requester,
                        target: Some(target),
                        participants: participants
                            .iter()
                            .map(PromptParticipantRow::to_identity_context_participant)
                            .collect(),
                        session_id: Some(session.id.clone()),
                        session_kind: Some(session.kind.clone()),
                        project_name: session.project_name.clone(),
                    },
                ));
            } else {
                push_concise_participants(&mut lines, &participants);
            }
            push_recent_session_messages(
                &mut lines,
                recent_session_message_lines(&conn, session_id, 12)?,
            );
            if let Some(context) = fallback_context
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                lines.push(String::new());
                lines.push("Context supplied by requester:".to_string());
                lines.push(context.to_string());
            }
        }
    } else if let Some(context) = fallback_context
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(String::new());
        lines.push("Context:".to_string());
        lines.push(context.to_string());
    }

    lines.push(String::new());
    lines.push("Request:".to_string());
    lines.push(request.to_string());
    Ok(lines.join("\n"))
}
