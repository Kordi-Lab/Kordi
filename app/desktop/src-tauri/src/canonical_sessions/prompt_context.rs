use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde_json::Value;

use super::schema::ensure_local_profile;
use super::{
    open_db, render_multi_participant_identity_context, select_identity, select_session,
    IdentityContextParticipant, IdentityContextPermissions, IdentityContextRequest,
    IdentityContextRole,
};

const SHARED_SESSION_BACKGROUND_WORK_POLICY: &str =
    "You are Kordi, the user's local agent participating inside this shared Kordi session. When the user mentions @Kordi, answer in this same parent session using the session context below. Before any tool call, privately assess routing: estimate the likely elapsed time and number of work phases, decide whether the parent session needs an immediate user choice or coordination, and decide whether an isolated agent session can own the work. Keep brief answers, clarification, permission checks, immediate user decisions, and tightly coupled parent-session actions inline. Prefer background execution when the work is self-contained and extended, especially research, full reviews, web-plus-repository comparisons, multi-file analysis, builds or tests, and tasks likely to require many tool calls. Do not use a rigid duration cutoff; use judgment about whether keeping the parent session occupied improves coordination. If background execution is better, call task_operator.spawn before update_plan or any other heavy tool. Give the child a concise taskTitle, a self-contained message, forkTurns='none', and the narrowest writeScope. If work started inline but reveals substantial additional phases, spawn the remaining work instead of continuing to occupy the parent. After a successful spawn, write a short normal response in this parent session and end the parent turn; do not wait for the child or duplicate its progress here. The linked agent session owns progress, follow-ups, cancellation, and the final result. When the user later asks for linked-session status or results, call task_operator.inspect with each exact sessionId returned by spawn. Do not infer linked-session status from task_operator list/wait, an empty live-agent registry, or durable task search records. Do not involve non-local participants unless the current user message explicitly mentions them. Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to.";

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
    fn is_remote_source(&self) -> bool {
        let source = self.source.trim();
        source.eq_ignore_ascii_case("cloud")
            || source.eq_ignore_ascii_case("collaboration")
            || source.eq_ignore_ascii_case("bridge")
    }

    fn is_local_source(&self) -> bool {
        self.source.trim().is_empty() || self.source.trim().eq_ignore_ascii_case("local")
    }

    fn to_identity_context_participant(&self) -> IdentityContextParticipant {
        let include_transport_ids = self.is_remote_source();
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
    if ["cloud", "collaboration", "bridge"]
        .iter()
        .any(|candidate| source.trim().eq_ignore_ascii_case(candidate))
    {
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
            "SELECT COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text, m.content_json, m.parent_message_id
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
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    messages.reverse();
    Ok(messages
        .into_iter()
        .map(|(sender, role, text, content_json, parent_message_id)| {
            let action_context =
                message_action_context(content_json.as_deref(), parent_message_id.as_deref());
            let line = format!("{} ({role}): {}", sender, truncate_context_line(&text, 700));
            match action_context {
                Some(context) => format!("{line} [{context}]"),
                None => line,
            }
        })
        .collect())
}

fn message_action_context(
    content_json: Option<&str>,
    parent_message_id: Option<&str>,
) -> Option<String> {
    let content = content_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| serde_json::from_str::<Value>(value).ok())?;
    let action = content.get("messageAction")?;
    let kind = action
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let source = action.get("source").and_then(Value::as_object)?;
    let source_message_id = source
        .get("sourceMessageId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            parent_message_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
    let sender = source
        .get("senderLabel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown sender");
    let preview = source
        .get("textPreview")
        .and_then(Value::as_str)
        .map(|value| truncate_context_line(value, 180))
        .filter(|value| !value.is_empty());
    match kind {
        "quote" => Some(format!(
            "quotes message {} from {}{}",
            source_message_id.unwrap_or("unknown"),
            sender,
            preview
                .map(|value| format!(": {value}"))
                .unwrap_or_default(),
        )),
        "forward" => Some(format!(
            "forwarded from message {} by {}{}",
            source_message_id.unwrap_or("unknown"),
            sender,
            preview
                .map(|value| format!(": {value}"))
                .unwrap_or_default(),
        )),
        _ => None,
    }
}

fn push_recent_session_messages(lines: &mut Vec<String>, messages: Vec<String>) {
    if !messages.is_empty() {
        lines.push(String::new());
        lines.push("Recent session messages:".to_string());
        lines.extend(messages);
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn task_id_from_result_text(value: &str) -> Option<String> {
    for marker in ["ID: `", "Task ID: `"] {
        let Some(start) = value.find(marker) else {
            continue;
        };
        let after_marker = &value[start + marker.len()..];
        let Some(end) = after_marker.find('`') else {
            continue;
        };
        let task_id = after_marker[..end].trim();
        if !task_id.is_empty() {
            return Some(task_id.to_string());
        }
    }
    None
}

fn visible_task_records_from_message_json(
    content_json: Option<&Value>,
) -> Result<Vec<kordi_cli::desktop_runtime::DesktopVisibleTaskRecord>, String> {
    let Some(content_json) = content_json else {
        return Ok(Vec::new());
    };
    let Some(tools) = content_json.get("tools").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for tool in tools {
        if !string_field(tool, "name")
            .is_some_and(|name| name.eq_ignore_ascii_case("task_operator"))
        {
            continue;
        }
        if bool_field(tool, "isError") {
            continue;
        }
        let Some(arguments) = string_field(tool, "arguments") else {
            continue;
        };
        let Ok(args) = serde_json::from_str::<Value>(&arguments) else {
            continue;
        };
        let Some(action) = string_field(&args, "action").map(|value| value.to_lowercase()) else {
            continue;
        };
        if action != "create" && action != "close" {
            continue;
        }
        let Some(task_id) = string_field(tool, "resultText")
            .as_deref()
            .and_then(task_id_from_result_text)
            .or_else(|| string_field(&args, "taskId"))
            .or_else(|| string_field(&args, "target"))
        else {
            continue;
        };
        let title = string_field(&args, "taskTitle")
            .or_else(|| string_field(content_json, "contentText"))
            .unwrap_or_else(|| task_id.clone());
        let involved_participants = args
            .get("involvedParticipants")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        records.push(kordi_cli::desktop_runtime::DesktopVisibleTaskRecord {
            task_id,
            parent_task_id: string_field(&args, "parentTaskId"),
            title,
            summary: string_field(&args, "summary"),
            status: if action == "close" {
                "closed".to_string()
            } else {
                string_field(&args, "status").unwrap_or_else(|| "open".to_string())
            },
            involved_participants,
        });
    }
    Ok(records)
}

pub(crate) fn local_agent_session_task_records(
    parent_session_id: Option<&str>,
) -> Result<Vec<kordi_cli::desktop_runtime::DesktopVisibleTaskRecord>, String> {
    let Some(session_id) = parent_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(Vec::new());
    };
    let conn = open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT content_json
             FROM session_messages
             WHERE session_id = ?1
             ORDER BY sequence_num ASC, created_at_ms ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| row.get::<_, Option<String>>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let mut by_id = BTreeMap::<String, kordi_cli::desktop_runtime::DesktopVisibleTaskRecord>::new();
    for raw in rows {
        let Some(raw) = raw else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        for mut record in visible_task_records_from_message_json(Some(&value))? {
            if let Some(existing) = by_id.get(&record.task_id) {
                if record.parent_task_id.is_none() {
                    record.parent_task_id = existing.parent_task_id.clone();
                }
                if record.summary.is_none() {
                    record.summary = existing.summary.clone();
                }
                if record.involved_participants.is_empty() {
                    record.involved_participants = existing.involved_participants.clone();
                }
                if record.title == record.task_id {
                    record.title = existing.title.clone();
                }
            }
            by_id.insert(record.task_id.clone(), record);
        }
    }
    Ok(by_id.into_values().collect())
}

fn push_current_session_tasks(
    lines: &mut Vec<String>,
    tasks: &[kordi_cli::desktop_runtime::DesktopVisibleTaskRecord],
) {
    let open_tasks = tasks
        .iter()
        .filter(|task| !task.status.eq_ignore_ascii_case("closed"))
        .collect::<Vec<_>>();
    if open_tasks.is_empty() {
        return;
    }
    lines.push(String::new());
    lines.push("Current session tasks (use these exact IDs with task_operator):".to_string());
    for task in open_tasks.iter().take(20) {
        let parent = task
            .parent_task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("; parent `{value}`"))
            .unwrap_or_default();
        lines.push(format!(
            "- ID `{}` — {} — status {}{}",
            task.task_id, task.title, task.status, parent
        ));
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

fn identity_permissions(
    reply_as_identity_id: &str,
    context_policy: &str,
) -> IdentityContextPermissions {
    IdentityContextPermissions {
        reply_as_identity_id: reply_as_identity_id.to_string(),
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
            .any(PromptParticipantRow::is_remote_source)
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
    lines.push(SHARED_SESSION_BACKGROUND_WORK_POLICY.to_string());

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
                permissions: identity_permissions(&self_identity.identity_id, "recent-window"),
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

    let task_records = local_agent_session_task_records(Some(session_id))?;
    push_current_session_tasks(&mut lines, &task_records);
    push_recent_session_messages(
        &mut lines,
        recent_session_message_lines(&conn, session_id, 16)?,
    );

    Ok(Some(lines.join("\n")))
}

#[cfg(test)]
mod task_record_tests {
    use super::visible_task_records_from_message_json;

    #[test]
    fn visible_task_records_from_message_json_extracts_task_operator_create_and_close() {
        let create_json = serde_json::json!({
            "tools": [{
                "name": "task_operator",
                "isError": false,
                "arguments": "{\"action\":\"create\",\"taskId\":\"be_happy_for_all_of_us\",\"taskTitle\":\"Be Happy For All Of Us\",\"summary\":\"Shared reminder\",\"involvedParticipants\":[\"Kordi User 2\"]}",
                "resultText": "Task created: Be Happy For All Of Us\n\nTasks:\n- ID: `task_955c84e4f40e4a0a8a479705b8eeb8fe`; title: Be Happy For All Of Us; status: open; summary: Shared reminder"
            }]
        });
        let close_json = serde_json::json!({
            "tools": [{
                "name": "task_operator",
                "isError": false,
                "arguments": "{\"action\":\"close\",\"taskId\":\"be_happy_for_all_of_us\",\"taskTitle\":\"Be Happy For All Of Us\"}"
            }]
        });

        let created =
            visible_task_records_from_message_json(Some(&create_json)).expect("create records");
        let closed =
            visible_task_records_from_message_json(Some(&close_json)).expect("close records");

        assert_eq!(created.len(), 1);
        assert_eq!(created[0].task_id, "task_955c84e4f40e4a0a8a479705b8eeb8fe");
        assert_eq!(created[0].title, "Be Happy For All Of Us");
        assert_eq!(created[0].status, "open");
        assert_eq!(
            created[0].involved_participants,
            vec!["Kordi User 2".to_string()]
        );
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].task_id, "be_happy_for_all_of_us");
        assert_eq!(closed[0].status, "closed");
    }
}

#[cfg(test)]
mod background_routing_tests {
    use super::SHARED_SESSION_BACKGROUND_WORK_POLICY;

    #[test]
    fn shared_session_policy_routes_by_duration_and_coordination_need() {
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("estimate the likely elapsed time"));
        assert!(
            SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("immediate user choice or coordination")
        );
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("web-plus-repository comparisons"));
        assert!(
            SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("Do not use a rigid duration cutoff")
        );
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY
            .contains("before update_plan or any other heavy tool"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("spawn the remaining work"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("forkTurns='none'"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("do not wait for the child"));
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("task_operator.inspect"));
        assert!(
            SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("Do not infer linked-session status")
        );
        assert!(SHARED_SESSION_BACKGROUND_WORK_POLICY.contains("Keep brief answers"));
    }
}
