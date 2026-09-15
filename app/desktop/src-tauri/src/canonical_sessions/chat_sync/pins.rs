use super::*;

pub(super) fn load_pin_events(conn: &Connection, account_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = conn.prepare("SELECT event_json FROM chat_sync_pin_events WHERE account_id=?1 AND event_id!='pin-cache-ready' ORDER BY stream_seq,event_id").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([account_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}

pub(super) fn pin_cache_ready(conn: &Connection, account_id: &str) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM chat_sync_pin_events WHERE account_id=?1 AND event_id='pin-cache-ready')", [account_id], |row| row.get(0)).map_err(|e| e.to_string())
}

pub(super) fn apply_pin_events(
    tx: &Transaction<'_>,
    account_id: &str,
    events: &[Value],
    bootstrap: bool,
) -> Result<(), String> {
    if bootstrap {
        tx.execute("DELETE FROM chat_sync_pin_events WHERE account_id=?1 AND event_id LIKE 'bootstrap:session-pin:%'", [account_id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chat_sync_pin_events WHERE account_id=?1 AND conversation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM chat_sync_conversations c WHERE c.account_id=?1 AND c.conversation_id=chat_sync_pin_events.conversation_id)", [account_id]).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO chat_sync_pin_events VALUES (?1,'pin-cache-ready',NULL,0,'{}')",
            [account_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for event in events {
        if event["type"] == "membership.removed" {
            tx.execute(
                "DELETE FROM chat_sync_pin_events WHERE account_id=?1 AND conversation_id=?2",
                params![account_id, event["conversation_id"].as_str()],
            )
            .map_err(|e| e.to_string())?;
        }
        if event["type"] == "session.deleted" {
            tx.execute("DELETE FROM chat_sync_pin_events WHERE account_id=?1 AND json_extract(event_json,'$.payload.sessionId')=?2", params![account_id,event["payload"]["sessionId"].as_str()]).map_err(|e| e.to_string())?;
        }
        if event["type"] != "session.pin.updated" {
            continue;
        }
        let id = required_text(event, "event_id")?;
        let sequence = required_i64(event, "stream_seq")?;
        tx.execute("INSERT INTO chat_sync_pin_events(account_id,event_id,conversation_id,stream_seq,event_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(account_id,event_id) DO UPDATE SET stream_seq=excluded.stream_seq,event_json=excluded.event_json", params![account_id,id,event["conversation_id"].as_str(),sequence,event.to_string()]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(id: &str, sequence: i64, message: Value) -> Value {
        json!({"event_id":id,"type":"session.pin.updated","stream_seq":sequence,"conversation_id":"conversation", "occurred_at":"2026-09-15T10:00:00Z", "payload":{"sessionId":"session:fixture","messageId":message,"scope":"shared","updatedByAccountId":"owner","updatedAt":"2026-09-15T10:00:00Z"}})
    }

    #[test]
    fn pin_cache_preserves_actions_and_bootstrap_state_in_the_account_transaction() {
        let mut conn = super::super::test_support::test_connection();
        conn.execute("INSERT INTO chat_sync_conversations(account_id,conversation_id) VALUES ('owner','conversation')", []).unwrap();
        assert!(!pin_cache_ready(&conn, "owner").unwrap());
        let tx = conn.transaction().unwrap();
        apply_pin_events(&tx, "owner", &[], true).unwrap();
        apply_pin_events(
            &tx,
            "owner",
            &[
                event("pin", 1, json!("target")),
                event("unpin", 2, Value::Null),
            ],
            false,
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(pin_cache_ready(&conn, "owner").unwrap());
        assert_eq!(load_pin_events(&conn, "owner").unwrap().len(), 2);
        assert!(load_pin_events(&conn, "another-account")
            .unwrap()
            .is_empty());
        let tx = conn.transaction().unwrap();
        apply_pin_events(
            &tx,
            "owner",
            &[event(
                "bootstrap:session-pin:fixture:shared",
                3,
                Value::Null,
            )],
            true,
        )
        .unwrap();
        tx.commit().unwrap();
        let restored = load_pin_events(&conn, "owner").unwrap();
        assert_eq!(restored.len(), 3);
        assert_eq!(restored[0]["event_id"], "pin");
        assert_eq!(restored[1]["event_id"], "unpin");
        let tx = conn.transaction().unwrap();
        apply_pin_events(
            &tx,
            "owner",
            &[event("rolled-back", 4, json!("other"))],
            false,
        )
        .unwrap();
        drop(tx);
        assert_eq!(load_pin_events(&conn, "owner").unwrap().len(), 3);
    }

    #[test]
    fn removed_memberships_and_deleted_sessions_drop_cached_private_history() {
        let mut conn = super::super::test_support::test_connection();
        let tx = conn.transaction().unwrap();
        apply_pin_events(&tx, "owner", &[event("pin", 1, json!("target"))], false).unwrap();
        apply_pin_events(
            &tx,
            "owner",
            &[json!({"type":"membership.removed","conversation_id":"conversation"})],
            false,
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(load_pin_events(&conn, "owner").unwrap().is_empty());
        let tx = conn.transaction().unwrap();
        apply_pin_events(&tx, "owner", &[event("pin", 2, json!("target"))], false).unwrap();
        apply_pin_events(
            &tx,
            "owner",
            &[json!({"type":"session.deleted","payload":{"sessionId":"session:fixture"}})],
            false,
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(load_pin_events(&conn, "owner").unwrap().is_empty());
    }
}
