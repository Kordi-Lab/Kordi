use super::*;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LegacySelfMessageKey {
    session_id: Option<String>,
    body: String,
}

const LEGACY_SELF_REPLAY_WINDOW_MS: i64 = 1_000;

fn legacy_self_message_created_at_ms(row: &MessageRecordRow) -> Option<i64> {
    DateTime::parse_from_rfc3339(&row.5)
        .ok()
        .map(|value| value.timestamp_millis())
}

pub(super) fn collapse_legacy_self_message_replays(
    rows: Vec<MessageRecordRow>,
    account_id: &str,
    message_ids_with_attachments: &HashSet<String>,
) -> Vec<MessageRecordRow> {
    let referenced_request_ids = rows
        .iter()
        .filter_map(|row| cloud_agent_control_request_id(&row.3))
        .collect::<HashSet<_>>();
    let mut candidates_by_key: HashMap<LegacySelfMessageKey, Vec<usize>> = HashMap::new();

    for (index, row) in rows.iter().enumerate() {
        if row.1 != account_id
            || row.2 != account_id
            || row.8.as_deref().is_some_and(|client_message_id| {
                !client_message_id.starts_with(LEGACY_SELF_MESSAGE_CLIENT_ID_PREFIX)
            })
            || message_ids_with_attachments.contains(&row.0)
        {
            continue;
        }
        candidates_by_key
            .entry(LegacySelfMessageKey {
                session_id: row.4.clone(),
                body: row.3.clone(),
            })
            .or_default()
            .push(index);
    }

    let mut hidden_indexes = HashSet::new();
    for mut indexes in candidates_by_key
        .into_values()
        .filter(|indexes| indexes.len() > 1)
    {
        indexes.sort_by(|left, right| {
            legacy_self_message_created_at_ms(&rows[*left])
                .cmp(&legacy_self_message_created_at_ms(&rows[*right]))
                .then_with(|| rows[*left].5.cmp(&rows[*right].5))
                .then_with(|| rows[*left].9.cmp(&rows[*right].9))
                .then_with(|| rows[*left].0.cmp(&rows[*right].0))
        });
        let mut cluster_start = 0;
        while cluster_start < indexes.len() {
            let anchor_index = indexes[cluster_start];
            let anchor_created_at_ms = legacy_self_message_created_at_ms(&rows[anchor_index]);
            let mut cluster_end = cluster_start + 1;
            while cluster_end < indexes.len() {
                let candidate_index = indexes[cluster_end];
                let candidate_created_at_ms =
                    legacy_self_message_created_at_ms(&rows[candidate_index]);
                let within_window = match (anchor_created_at_ms, candidate_created_at_ms) {
                    (Some(anchor), Some(candidate)) => {
                        candidate.saturating_sub(anchor) < LEGACY_SELF_REPLAY_WINDOW_MS
                    }
                    _ => rows[candidate_index].5 == rows[anchor_index].5,
                };
                if !within_window {
                    break;
                }
                cluster_end += 1;
            }
            let cluster = &indexes[cluster_start..cluster_end];
            if cluster.len() > 1 {
                let referenced_indexes = cluster
                    .iter()
                    .copied()
                    .filter(|index| referenced_request_ids.contains(&rows[*index].0))
                    .collect::<HashSet<_>>();
                let keeper = if referenced_indexes.is_empty() {
                    cluster
                        .iter()
                        .copied()
                        .min_by(|left, right| {
                            rows[*left]
                                .9
                                .cmp(&rows[*right].9)
                                .then_with(|| rows[*left].0.cmp(&rows[*right].0))
                        })
                        .expect("duplicate cluster is not empty")
                } else {
                    referenced_indexes
                        .iter()
                        .copied()
                        .min_by(|left, right| {
                            rows[*left]
                                .9
                                .cmp(&rows[*right].9)
                                .then_with(|| rows[*left].0.cmp(&rows[*right].0))
                        })
                        .expect("referenced duplicate cluster is not empty")
                };
                hidden_indexes.extend(
                    cluster.iter().copied().filter(|index| *index != keeper),
                );
            }
            cluster_start = cluster_end;
        }
    }

    let hidden_request_ids = hidden_indexes
        .iter()
        .map(|index| rows[*index].0.as_str())
        .collect::<HashSet<_>>();
    for (index, row) in rows.iter().enumerate() {
        if cloud_agent_control_request_id(&row.3)
            .is_some_and(|request_id| hidden_request_ids.contains(request_id.as_str()))
        {
            hidden_indexes.insert(index);
        }
    }

    rows.into_iter()
        .enumerate()
        .filter_map(|(index, row)| (!hidden_indexes.contains(&index)).then_some(row))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn row(
        message_id: &str,
        body: &str,
        created_at: &str,
        client_message_id: Option<&str>,
        server_second: u32,
    ) -> MessageRecordRow {
        (
            message_id.to_string(),
            "acct_me".to_string(),
            "acct_me".to_string(),
            body.to_string(),
            Some("session:agent".to_string()),
            created_at.to_string(),
            Some(created_at.to_string()),
            Some(created_at.to_string()),
            client_message_id.map(ToString::to_string),
            Utc.with_ymd_and_hms(2026, 8, 8, 17, 18, server_second)
                .unwrap(),
        )
    }

    #[test]
    fn near_time_legacy_self_replays_collapse_to_the_first_server_receipt() {
        let created_at = "2026-07-22T12:15:12.674+00:00";
        let rows = vec![
            row("msg_later", "same prompt", created_at, None, 51),
            row("msg_first", "same prompt", created_at, None, 42),
            row(
                "msg_near_replay",
                "same prompt",
                "2026-07-22T12:15:13.100+00:00",
                None,
                52,
            ),
            row(
                "msg_other_time",
                "same prompt",
                "2026-07-22T12:15:14+00:00",
                None,
                53,
            ),
            row(
                "msg_canonical",
                "same prompt",
                created_at,
                Some("ios_1"),
                54,
            ),
        ];

        let collapsed = collapse_legacy_self_message_replays(rows, "acct_me", &HashSet::new());
        let ids = collapsed.into_iter().map(|row| row.0).collect::<Vec<_>>();

        assert_eq!(ids, vec!["msg_first", "msg_other_time", "msg_canonical"]);
    }

    #[test]
    fn a_legacy_request_referenced_by_an_agent_response_is_preserved() {
        let created_at = "2026-07-22T12:15:12.674+00:00";
        let response_body = response_body("msg_referenced");
        let rows = vec![
            row("msg_first", "same prompt", created_at, None, 42),
            row("msg_referenced", "same prompt", created_at, None, 51),
            row(
                "msg_response",
                &response_body,
                "2026-07-22T12:15:14+00:00",
                None,
                52,
            ),
        ];

        let collapsed = collapse_legacy_self_message_replays(rows, "acct_me", &HashSet::new());
        let ids = collapsed.into_iter().map(|row| row.0).collect::<Vec<_>>();

        assert_eq!(ids, vec!["msg_referenced", "msg_response"]);
    }

    fn response_body(request_id: &str) -> String {
        format!(
            "{CLOUD_AGENT_RESPONSE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(
                serde_json::json!({
                    "kind": "agent-response",
                    "requestId": request_id,
                    "text": "same answer",
                })
                .to_string()
            )
        )
    }

    #[test]
    fn a_duplicate_request_and_its_duplicate_response_are_hidden_together() {
        let rows = vec![
            row(
                "msg_request_first",
                "same prompt",
                "2026-07-22T12:15:12.000+00:00",
                None,
                40,
            ),
            row(
                "msg_request_duplicate",
                "same prompt",
                "2026-07-22T12:15:12.650+00:00",
                None,
                41,
            ),
            row(
                "msg_response_first",
                &response_body("msg_request_first"),
                "2026-07-22T12:15:13.000+00:00",
                None,
                42,
            ),
            row(
                "msg_response_duplicate",
                &response_body("msg_request_duplicate"),
                "2026-07-22T12:15:13.650+00:00",
                None,
                43,
            ),
        ];

        let collapsed = collapse_legacy_self_message_replays(rows, "acct_me", &HashSet::new());
        let ids = collapsed.into_iter().map(|row| row.0).collect::<Vec<_>>();

        assert_eq!(ids, vec!["msg_request_first", "msg_response_first"]);
    }

    #[test]
    fn attachment_messages_are_never_collapsed() {
        let created_at = "2026-07-22T12:15:12.674+00:00";
        let rows = vec![
            row("msg_attachment_a", "", created_at, None, 42),
            row("msg_attachment_b", "", created_at, None, 43),
        ];
        let attachment_ids = HashSet::from([
            "msg_attachment_a".to_string(),
            "msg_attachment_b".to_string(),
        ]);

        let collapsed = collapse_legacy_self_message_replays(rows, "acct_me", &attachment_ids);

        assert_eq!(collapsed.len(), 2);
    }
}
