//! Chunked acknowledgement and mailbox-deletion regression scenarios.

use super::*;

#[tokio::test]
async fn ack_chunks_more_than_three_chunks_of_message_ids() {
    // Exercises the chunked IN-clause DELETE — well above ACK_CHUNK_SIZE
    // (256) so the code path runs three chunks. Stays under
    // MAX_MAILBOX_PER_NODE (1000) to keep enqueue acceptance.
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    let total = 768usize;
    for index in 0..total {
        seed_mailbox_entry(&state, "sender", "receiver", &format!("blob-{index}"));
    }

    let mut all_ids: Vec<String> = Vec::with_capacity(total);
    let mut after: Option<String> = None;
    loop {
        let page = poll_mailbox_v2(
            State(state.clone()),
            Extension(AuthNode("receiver".to_string())),
            Json(MailboxPollReq {
                limit: Some(500),
                after: after.clone(),
            }),
        )
        .await
        .expect("poll page")
        .0;
        if page.entries.is_empty() {
            break;
        }
        after = page.entries.last().map(|entry| entry.message_id.clone());
        all_ids.extend(page.entries.into_iter().map(|entry| entry.message_id));
    }
    assert_eq!(all_ids.len(), total);

    ack_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxAckReq {
            message_ids: all_ids,
        }),
    )
    .await
    .expect("ack many");

    let after_ack = poll_mailbox_v2(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
        Json(MailboxPollReq {
            limit: Some(2000),
            after: None,
        }),
    )
    .await
    .expect("poll after ack")
    .0;
    assert_eq!(after_ack.entries.len(), 0, "every chunked id was acked");

    // Sanity-check the DB itself — the table should be empty for this target.
    let conn = state.open_connection().unwrap();
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = ?1",
            params!["receiver"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 0);
}
