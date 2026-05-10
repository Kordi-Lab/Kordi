//! `server_messages` + `server_message_recipients` write layer.
//!
//! Phase 2 PR 2.2 of [#332](https://github.com/Kordi-AI/Kordi/issues/332).
//! This module owns the schema introduced by migration 5: one immutable row
//! per send in `server_messages`, plus one row per recipient with delivery
//! and read cursors in `server_message_recipients`. Broadcast fanout writes
//! 1 message + N tiny recipient rows instead of N full-copy mailbox rows.
//!
//! No production handler reads or writes through this module yet. PR 2.3
//! turns on dual-write for `/v1/relay` and `/v1/broadcast`; PR 2.4 flips
//! `/v1/mailbox/poll` and `/v1/mailbox/ack` to read from these tables.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertMessage<'a> {
    pub sender_node_id: &'a str,
    pub project_id: Option<&'a str>,
    /// Payload shared across recipients (used when E2EE doesn't vary per peer).
    /// `Some` when broadcast carries a single envelope; `None` when each
    /// recipient gets its own ciphertext via `InsertRecipient::ciphertext_blob`.
    pub payload_blob: Option<&'a str>,
    pub client_message_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertRecipient<'a> {
    pub recipient_node_id: &'a str,
    /// Per-recipient ciphertext when each peer needs a different envelope.
    /// `None` when the body is in `InsertMessage::payload_blob`.
    pub ciphertext_blob: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertOutcome {
    /// Fresh message + recipient rows landed.
    Inserted {
        message_id: String,
        recipients_inserted: usize,
    },
    /// Sender + client_message_id matched an earlier send. No new rows
    /// produced; the original message id is returned for the caller to echo.
    Duplicate { message_id: String },
}

/// Insert one message and all its recipient rows in a single transaction.
/// Idempotent on `(sender_node_id, client_message_id)` — repeating the same
/// pair returns the original message id without writing new recipient rows.
///
/// Caller passes recipients as a slice; an empty slice is allowed (a "send
/// to nobody" — useful for senders who want to record the message for their
/// own outbox even if no peer is currently reachable).
pub fn insert_message_with_recipients(
    conn: &mut Connection,
    message: &InsertMessage<'_>,
    recipients: &[InsertRecipient<'_>],
) -> Result<InsertOutcome, rusqlite::Error> {
    if let Some(client_id) = message.client_message_id {
        if let Some(existing) = lookup_message_by_client_id_inner(conn, message.sender_node_id, client_id)? {
            return Ok(InsertOutcome::Duplicate {
                message_id: existing,
            });
        }
    }

    let tx = conn.transaction()?;
    let message_id = format!("msg_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();

    tx.execute(
        "INSERT INTO server_messages \
         (message_id, sender_node_id, project_id, payload_blob, client_message_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            message_id,
            message.sender_node_id,
            message.project_id,
            message.payload_blob,
            message.client_message_id,
            now,
        ],
    )?;

    let mut inserted = 0usize;
    if !recipients.is_empty() {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO server_message_recipients \
             (message_id, recipient_node_id, ciphertext_blob) \
             VALUES (?1, ?2, ?3)",
        )?;
        for recipient in recipients {
            inserted += stmt.execute(params![
                message_id,
                recipient.recipient_node_id,
                recipient.ciphertext_blob,
            ])?;
        }
    }
    drop(/* finalize the prepared statement before commit */ ());
    tx.commit()?;

    Ok(InsertOutcome::Inserted {
        message_id,
        recipients_inserted: inserted,
    })
}

/// Find an existing message by `(sender_node_id, client_message_id)`.
/// Returns the server-assigned `message_id` if a match exists.
pub fn lookup_message_by_client_id(
    conn: &Connection,
    sender_node_id: &str,
    client_message_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    lookup_message_by_client_id_inner(conn, sender_node_id, client_message_id)
}

fn lookup_message_by_client_id_inner(
    conn: &Connection,
    sender_node_id: &str,
    client_message_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT message_id FROM server_messages \
         WHERE sender_node_id = ?1 AND client_message_id = ?2",
        params![sender_node_id, client_message_id],
        |row| row.get(0),
    )
    .optional()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientDelivery {
    pub message_id: String,
    pub recipient_node_id: String,
    pub delivered_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
}

/// Mark a recipient row as delivered. Idempotent: a second call is a no-op
/// rather than rewriting the timestamp, so the original delivery time is
/// preserved.
pub fn mark_delivered(
    conn: &Connection,
    message_id: &str,
    recipient_node_id: &str,
) -> Result<(), rusqlite::Error> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE server_message_recipients \
         SET delivered_at = COALESCE(delivered_at, ?1) \
         WHERE message_id = ?2 AND recipient_node_id = ?3",
        params![now, message_id, recipient_node_id],
    )?;
    Ok(())
}

/// Mark a recipient row as read. Idempotent for the same reason — the
/// original read time is preserved on subsequent calls.
pub fn mark_read(
    conn: &Connection,
    message_id: &str,
    recipient_node_id: &str,
) -> Result<(), rusqlite::Error> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE server_message_recipients \
         SET read_at = COALESCE(read_at, ?1) \
         WHERE message_id = ?2 AND recipient_node_id = ?3",
        params![now, message_id, recipient_node_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        super::super::init_server_db(&conn).expect("init server db");
        conn
    }

    fn insert_simple(
        conn: &mut Connection,
        sender: &str,
        client_id: Option<&str>,
        recipients: &[&str],
    ) -> InsertOutcome {
        let recipient_rows: Vec<InsertRecipient<'_>> = recipients
            .iter()
            .map(|recipient| InsertRecipient {
                recipient_node_id: recipient,
                ciphertext_blob: None,
            })
            .collect();
        insert_message_with_recipients(
            conn,
            &InsertMessage {
                sender_node_id: sender,
                project_id: None,
                payload_blob: Some("payload"),
                client_message_id: client_id,
            },
            &recipient_rows,
        )
        .expect("insert message")
    }

    #[test]
    fn insert_message_with_one_recipient_persists_both_rows() {
        let mut conn = open_test_db();
        let outcome = insert_simple(&mut conn, "sender-a", None, &["recipient-1"]);
        let message_id = match outcome {
            InsertOutcome::Inserted { message_id, recipients_inserted } => {
                assert_eq!(recipients_inserted, 1);
                message_id
            }
            _ => panic!("expected Inserted, got {outcome:?}"),
        };
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_messages WHERE message_id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        let recipient_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_message_recipients WHERE message_id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recipient_count, 1);
    }

    #[test]
    fn fanout_to_many_recipients_writes_one_message_and_n_recipients() {
        let mut conn = open_test_db();
        let recipients = (0..50).map(|i| format!("recipient-{i}")).collect::<Vec<_>>();
        let recipient_refs: Vec<&str> = recipients.iter().map(String::as_str).collect();
        let outcome = insert_simple(&mut conn, "sender-broadcaster", None, &recipient_refs);
        match outcome {
            InsertOutcome::Inserted { recipients_inserted, .. } => {
                assert_eq!(recipients_inserted, 50);
            }
            _ => panic!("expected Inserted"),
        }
        let messages: i64 = conn
            .query_row("SELECT COUNT(*) FROM server_messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(messages, 1, "broadcast must write exactly one server_messages row");
        let recipient_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_message_recipients",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recipient_rows, 50);
    }

    #[test]
    fn idempotent_insert_returns_original_message_id() {
        let mut conn = open_test_db();
        let first = insert_simple(&mut conn, "sender-b", Some("client-msg-1"), &["r1"]);
        let original_id = match first {
            InsertOutcome::Inserted { ref message_id, .. } => message_id.clone(),
            _ => panic!("first insert must be fresh"),
        };
        let retry = insert_simple(&mut conn, "sender-b", Some("client-msg-1"), &["r1", "r2"]);
        match retry {
            InsertOutcome::Duplicate { ref message_id } => {
                assert_eq!(message_id, &original_id);
            }
            _ => panic!("retry with same client_message_id must be Duplicate, got {retry:?}"),
        }
        // Recipient rows from the retry must NOT be appended — the original
        // recipient set is preserved.
        let recipient_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_message_recipients WHERE message_id = ?1",
                params![original_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recipient_rows, 1);
    }

    #[test]
    fn lookup_message_by_client_id_finds_existing_and_misses_unknown() {
        let mut conn = open_test_db();
        let outcome = insert_simple(&mut conn, "sender-c", Some("k"), &["r"]);
        let id = match outcome {
            InsertOutcome::Inserted { message_id, .. } => message_id,
            _ => unreachable!(),
        };
        let found = lookup_message_by_client_id(&conn, "sender-c", "k").unwrap();
        assert_eq!(found.as_deref(), Some(id.as_str()));
        let missed = lookup_message_by_client_id(&conn, "sender-c", "different-key").unwrap();
        assert_eq!(missed, None);
        let wrong_sender = lookup_message_by_client_id(&conn, "sender-other", "k").unwrap();
        assert_eq!(wrong_sender, None, "client keys are scoped per sender");
    }

    #[test]
    fn cascade_delete_removes_recipient_rows() {
        // Migration 5 declared FOREIGN KEY ... ON DELETE CASCADE; verify the
        // PRAGMA the connection helper sets is enforcing it for these tables.
        let mut conn = open_test_db();
        let outcome = insert_simple(&mut conn, "sender-d", None, &["r1", "r2", "r3"]);
        let message_id = match outcome {
            InsertOutcome::Inserted { message_id, .. } => message_id,
            _ => unreachable!(),
        };
        conn.execute(
            "DELETE FROM server_messages WHERE message_id = ?1",
            params![message_id],
        )
        .expect("delete message");
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM server_message_recipients WHERE message_id = ?1",
                params![message_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0, "ON DELETE CASCADE should reap recipient rows");
    }

    #[test]
    fn mark_delivered_and_read_are_idempotent() {
        let mut conn = open_test_db();
        let outcome = insert_simple(&mut conn, "sender-e", None, &["r1"]);
        let message_id = match outcome {
            InsertOutcome::Inserted { message_id, .. } => message_id,
            _ => unreachable!(),
        };
        mark_delivered(&conn, &message_id, "r1").unwrap();
        let first_delivered: String = conn
            .query_row(
                "SELECT delivered_at FROM server_message_recipients WHERE message_id = ?1 AND recipient_node_id = ?2",
                params![message_id, "r1"],
                |row| row.get(0),
            )
            .unwrap();
        // Second call must keep the same delivered_at — original timestamp wins.
        std::thread::sleep(std::time::Duration::from_millis(5));
        mark_delivered(&conn, &message_id, "r1").unwrap();
        let second_delivered: String = conn
            .query_row(
                "SELECT delivered_at FROM server_message_recipients WHERE message_id = ?1 AND recipient_node_id = ?2",
                params![message_id, "r1"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(first_delivered, second_delivered);

        mark_read(&conn, &message_id, "r1").unwrap();
        let read_at: Option<String> = conn
            .query_row(
                "SELECT read_at FROM server_message_recipients WHERE message_id = ?1 AND recipient_node_id = ?2",
                params![message_id, "r1"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(read_at.is_some());
    }
}
