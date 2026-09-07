use super::*;

#[cfg(test)]
mod tests;

pub(super) fn load_visibility(
    conn: &Connection,
    account_id: &str,
) -> Result<Option<Value>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT snapshot_json FROM chat_sync_visibility WHERE account_id=?1",
            [account_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
        .transpose()
}

pub(super) fn apply_visibility_events(
    tx: &Transaction<'_>,
    account_id: &str,
    events: &[Value],
    bootstrap: bool,
) -> Result<(), String> {
    let mut snapshot = if bootstrap {
        None
    } else {
        load_visibility(tx, account_id)?
    };
    for event in events {
        let kind = event["type"].as_str().unwrap_or_default();
        let payload = &event["payload"];
        if kind == "session.visibility.snapshot" {
            let value = &payload["visibility"];
            for key in [
                "hiddenSessionIds",
                "deletedSessionIds",
                "pinnedSessionIds",
                "mutedSessionIds",
                "unreadSessionIds",
                "pinnedGroupSpaceIds",
            ] {
                if !value[key]
                    .as_array()
                    .is_some_and(|ids| ids.iter().all(Value::is_string))
                {
                    return Err("Chat visibility snapshot is incomplete".into());
                }
            }
            snapshot = Some(value.clone());
            continue;
        }
        let Some(value) = snapshot.as_mut() else {
            continue;
        };
        let id = payload["sessionId"]
            .as_str()
            .or_else(|| payload["groupSpaceId"].as_str())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let mut change = |key: &str, present: bool| {
            if let Some(ids) = value[key].as_array_mut() {
                ids.retain(|value| value.as_str() != Some(id));
                if present {
                    ids.push(Value::String(id.into()));
                }
            }
        };
        match kind {
            "session.hidden" => {
                change("hiddenSessionIds", true);
                change("pinnedSessionIds", false);
            }
            "session.unhidden" => {
                change("hiddenSessionIds", false);
                change("deletedSessionIds", false);
            }
            "session.deleted" => {
                change("deletedSessionIds", true);
                for key in [
                    "hiddenSessionIds",
                    "pinnedSessionIds",
                    "mutedSessionIds",
                    "unreadSessionIds",
                ] {
                    change(key, false);
                }
            }
            "session.pinned" => change("pinnedSessionIds", true),
            "session.unpinned" => change("pinnedSessionIds", false),
            "session.muted" => change("mutedSessionIds", true),
            "session.unmuted" => change("mutedSessionIds", false),
            "session.marked_unread" => change("unreadSessionIds", true),
            "session.unmarked_unread" => change("unreadSessionIds", false),
            "group_space.pinned" => change("pinnedGroupSpaceIds", true),
            "group_space.unpinned" => change("pinnedGroupSpaceIds", false),
            _ => {}
        }
    }
    if let Some(snapshot) = snapshot {
        tx.execute("INSERT INTO chat_sync_visibility(account_id,snapshot_json) VALUES (?1,?2) ON CONFLICT(account_id) DO UPDATE SET snapshot_json=excluded.snapshot_json",
            params![account_id,snapshot.to_string()]).map_err(|error| error.to_string())?;
    } else if bootstrap {
        tx.execute(
            "DELETE FROM chat_sync_visibility WHERE account_id=?1",
            [account_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
