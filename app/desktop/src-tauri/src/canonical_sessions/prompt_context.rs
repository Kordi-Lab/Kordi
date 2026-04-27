use rusqlite::params;

use super::{open_db, select_session};

fn truncate_context_line(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim().replace('\n', " ");
    let mut chars = trimmed.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
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
    if select_session(&conn, session_id)?.is_none() {
        return Ok(None);
    }

    let mut lines = Vec::new();
    lines.push(
        "You are Kordi, the user's local agent participating inside this shared Kordi session. When the user mentions @Kordi, answer directly in this same session using the session context below. Do not create or switch sessions. Do not involve bridge participants unless the current user message explicitly mentions a non-local person or agent. Do not begin your reply with @Name or a speaker label; the chat UI already shows who you are replying to."
            .to_string(),
    );

    let mut participant_stmt = conn
        .prepare(
            "SELECT i.display_name, i.kind, sp.role, owner.display_name
             FROM session_participants sp
             JOIN identities i ON i.id = sp.identity_id
             LEFT JOIN identities owner ON owner.id = i.owner_identity_id
             WHERE sp.session_id = ?1
             ORDER BY sp.added_at_ms ASC, i.display_name ASC",
        )
        .map_err(|err| err.to_string())?;
    let participants = participant_stmt
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    if !participants.is_empty() {
        lines.push(String::new());
        lines.push("Session participants:".to_string());
        for (name, kind, role, owner) in participants.into_iter().take(12) {
            let owner_suffix = owner
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|owner| format!(", owner: {owner}"))
                .unwrap_or_default();
            lines.push(format!("- {name} ({kind}, {role}{owner_suffix})"));
        }
    }

    let mut message_stmt = conn
        .prepare(
            "SELECT COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1
               AND TRIM(m.content_text) <> ''
             ORDER BY m.created_at_ms DESC, m.sequence_num DESC
             LIMIT 16",
        )
        .map_err(|err| err.to_string())?;
    let mut messages = message_stmt
        .query_map(params![session_id], |row| {
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
    if !messages.is_empty() {
        lines.push(String::new());
        lines.push("Recent session messages:".to_string());
        for (sender, role, text) in messages {
            lines.push(format!(
                "{} ({role}): {}",
                sender,
                truncate_context_line(&text, 700)
            ));
        }
    }

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

    if let Some(session_id) = parent_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let conn = open_db()?;
        let mut participant_stmt = conn
            .prepare(
                "SELECT i.display_name, i.kind, sp.role, owner.display_name
                 FROM session_participants sp
                 JOIN identities i ON i.id = sp.identity_id
                 LEFT JOIN identities owner ON owner.id = i.owner_identity_id
                 WHERE sp.session_id = ?1
                 ORDER BY sp.added_at_ms ASC, i.display_name ASC",
            )
            .map_err(|err| err.to_string())?;
        let participants = participant_stmt
            .query_map(params![session_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        if !participants.is_empty() {
            lines.push(String::new());
            lines.push("Session participants:".to_string());
            for (name, kind, role, owner) in participants.into_iter().take(12) {
                let owner_suffix = owner
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|owner| format!(", owner: {owner}"))
                    .unwrap_or_default();
                lines.push(format!("- {name} ({kind}, {role}{owner_suffix})"));
            }
        }

        let mut message_stmt = conn
            .prepare(
                "SELECT COALESCE(i.display_name, m.sender_role), m.sender_role, m.content_text
                 FROM session_messages m
                 LEFT JOIN identities i ON i.id = m.sender_identity_id
                 WHERE m.session_id = ?1
                   AND TRIM(m.content_text) <> ''
                 ORDER BY m.sequence_num DESC, m.created_at_ms DESC
                 LIMIT 12",
            )
            .map_err(|err| err.to_string())?;
        let mut messages = message_stmt
            .query_map(params![session_id], |row| {
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
        if !messages.is_empty() {
            lines.push(String::new());
            lines.push("Recent session messages:".to_string());
            for (sender, role, text) in messages {
                lines.push(format!(
                    "{} ({role}): {}",
                    sender,
                    truncate_context_line(&text, 700)
                ));
            }
        }
        if let Some(context) = fallback_context
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            lines.push(String::new());
            lines.push("Context supplied by requester:".to_string());
            lines.push(context.to_string());
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
