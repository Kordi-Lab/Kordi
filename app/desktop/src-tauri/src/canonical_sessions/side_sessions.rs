//! Explicit side chats own an empty session, not the main composer's draft.
use super::*;

pub(crate) fn initialize_private_side_session(
    id: &str,
    source: Option<&str>,
    cwd: &str,
) -> Result<(), String> {
    initialize_in_db(&open_db()?, id, source, cwd)
}

fn initialize_in_db(
    conn: &Connection,
    id: &str,
    source: Option<&str>,
    cwd: &str,
) -> Result<(), String> {
    if select_session(conn, id)?.is_some() {
        return Err("New chat requires a new session identity.".into());
    }
    let human = local_profile_human_identity_id(conn, "You")?;
    let mut metadata = serde_json::json!({
        "source": "ask-agent-new-chat", "createdFrom": "chat-create-flow",
        "sessionTitleSource": "placeholder", "titleSource": "placeholder",
    });
    let (kind, agent) = if let Some(source_id) = source {
        let session =
            select_session(conn, source_id)?.ok_or("Source Agent session is unavailable.")?;
        if !matches!(
            session.kind.as_str(),
            "self-agent" | "direct-agent" | "project"
        ) || session.created_by_identity_id != human
        {
            return Err("New chat can only continue your private Agent identity.".into());
        }
        let identity = session
            .primary_identity_id
            .as_deref()
            .map(|id| select_identity(conn, id))
            .transpose()?
            .flatten()
            .filter(|identity| {
                identity.kind == "agent" && identity.owner_identity_id.as_deref() == Some(&human)
            })
            .ok_or("The source Agent is not owned by the current account.")?;
        canonical_fork::copy_agent_metadata(
            session
                .metadata
                .as_ref()
                .unwrap_or(&serde_json::Value::Null),
            &mut metadata,
        );
        (
            if session.kind == "direct-agent" {
                "direct-agent"
            } else {
                "self-agent"
            },
            identity.id,
        )
    } else {
        (
            "self-agent",
            local_agent_identity_id(conn, &human, "Kordi", cwd)?,
        )
    };
    metadata["createdFrom"] = serde_json::json!("chat-create-flow");
    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some(id.to_string()),
            kind: kind.to_string(),
            title: Some("New chat".into()),
            status: Some("active".into()),
            created_by_identity_id: human.clone(),
            primary_identity_id: Some(agent.clone()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec![human, agent],
            metadata: Some(metadata),
        },
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn side_chats_are_distinct_empty_private_sessions_without_fork_history() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        initialize_in_db(&conn, "source", None, "/workspace").unwrap();
        let source = select_session(&conn, "source").unwrap().unwrap();
        conn.execute("UPDATE sessions SET metadata_json=?1 WHERE id='source'", [serde_json::json!({
            "cloudAgentId":"agent-selected", "cloudAgentSystemPrompt":"Agent definition", "fork":{"forkedFromSessionId":"other"},
            "groupId":"not-inherited", "privateHistory":"not-inherited",
        }).to_string()]).unwrap();
        initialize_in_db(&conn, "first", Some("source"), "/workspace").unwrap();
        initialize_in_db(&conn, "second", Some("source"), "/workspace").unwrap();
        for id in ["first", "second"] {
            let target = select_session(&conn, id).unwrap().unwrap();
            assert_eq!(target.primary_identity_id, source.primary_identity_id);
            assert_eq!(target.created_by_identity_id, source.created_by_identity_id);
            let metadata = target.metadata.unwrap();
            assert_eq!(metadata["source"], "ask-agent-new-chat");
            assert_eq!(metadata["cloudAgentId"], "agent-selected");
            assert!(
                metadata.get("fork").is_none()
                    && metadata.get("privateHistory").is_none()
                    && metadata.get("groupId").is_none()
            );
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM session_messages WHERE session_id=?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
        assert!(initialize_in_db(&conn, "first", Some("source"), "/workspace").is_err());
        conn.execute(
            "UPDATE sessions SET created_by_identity_id='another-owner' WHERE id='source'",
            [],
        )
        .unwrap();
        assert!(initialize_in_db(&conn, "forbidden", Some("source"), "/workspace").is_err());
        assert!(select_session(&conn, "forbidden").unwrap().is_none());
    }
}
