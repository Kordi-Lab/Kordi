use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, TransactionBehavior};

use super::super::open_db;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct LegacySelfReplayKey {
    session_id: String,
    sender_identity_id: String,
    sender_role: String,
    message_kind: String,
    content_text: String,
}

#[derive(Debug)]
struct LegacySelfReplayCandidate {
    id: String,
    key: LegacySelfReplayKey,
    sequence_num: i64,
    created_at_ms: i64,
}

const LEGACY_SELF_REPLAY_WINDOW_MS: i64 = 1_000;

fn referenced_canonical_message_ids(
    conn: &Connection,
    candidate_ids: &HashSet<String>,
) -> Result<HashSet<String>, String> {
    let mut referenced = HashSet::new();
    let mut statement = conn
        .prepare(
            "SELECT parent_message_id FROM session_messages
             WHERE parent_message_id IS NOT NULL
             UNION ALL
             SELECT last_read_message_id FROM session_participants
             WHERE last_read_message_id IS NOT NULL
             UNION ALL
             SELECT trigger_message_id FROM delegated_exchanges
             WHERE trigger_message_id IS NOT NULL
             UNION ALL
             SELECT request_message_id FROM delegated_exchanges
             WHERE request_message_id IS NOT NULL
             UNION ALL
             SELECT response_message_id FROM delegated_exchanges
             WHERE response_message_id IS NOT NULL
             UNION ALL
             SELECT upto_message_id FROM context_snapshots
             WHERE upto_message_id IS NOT NULL
             UNION ALL
             SELECT json_extract(content_json, '$.replyToMessageId')
             FROM session_messages
             WHERE json_valid(content_json)
               AND json_type(content_json, '$.replyToMessageId') = 'text'
             UNION ALL
             SELECT json_extract(content_json, '$.requestId')
             FROM session_messages
             WHERE json_valid(content_json)
               AND json_type(content_json, '$.requestId') = 'text'
             UNION ALL
             SELECT json_extract(content_json, '$.cloudRequestMessageId')
             FROM session_messages
             WHERE json_valid(content_json)
               AND json_type(content_json, '$.cloudRequestMessageId') = 'text'
             UNION ALL
             SELECT json_extract(content_json, '$.messageAction.source.sourceMessageId')
             FROM session_messages
             WHERE json_valid(content_json)
               AND json_type(content_json, '$.messageAction.source.sourceMessageId') = 'text'
             UNION ALL
             SELECT json_extract(metadata_json, '$.fork.forkedFromMessageId')
             FROM sessions
             WHERE json_valid(metadata_json)
               AND json_type(metadata_json, '$.fork.forkedFromMessageId') = 'text'
             UNION ALL
             SELECT CAST(alias.value AS TEXT)
             FROM sessions
             JOIN json_each(sessions.metadata_json, '$.fork.forkedFromMessageAliases') AS alias
             WHERE json_valid(sessions.metadata_json)
               AND alias.type = 'text'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    for row in rows {
        let message_id = row.map_err(|error| error.to_string())?;
        if candidate_ids.contains(&message_id) {
            referenced.insert(message_id);
        }
    }
    Ok(referenced)
}

fn repoint_canonical_message_references(
    conn: &Connection,
    duplicate_id: &str,
    keeper_id: &str,
) -> Result<(), String> {
    for statement in [
        "UPDATE session_messages SET parent_message_id = ?2 WHERE parent_message_id = ?1",
        "UPDATE session_participants SET last_read_message_id = ?2 WHERE last_read_message_id = ?1",
        "UPDATE delegated_exchanges SET trigger_message_id = ?2 WHERE trigger_message_id = ?1",
        "UPDATE delegated_exchanges SET request_message_id = ?2 WHERE request_message_id = ?1",
        "UPDATE delegated_exchanges SET response_message_id = ?2 WHERE response_message_id = ?1",
        "UPDATE context_snapshots SET upto_message_id = ?2 WHERE upto_message_id = ?1",
        "UPDATE sessions SET metadata_json = json_set(metadata_json, '$.fork.forkedFromMessageId', ?2) \
         WHERE json_valid(metadata_json) \
           AND json_extract(metadata_json, '$.fork.forkedFromMessageId') = ?1",
    ] {
        conn.execute(statement, params![duplicate_id, keeper_id])
            .map_err(|error| error.to_string())?;
    }
    for path in [
        "$.replyToMessageId",
        "$.requestId",
        "$.cloudRequestMessageId",
        "$.messageAction.source.sourceMessageId",
    ] {
        conn.execute(
            &format!(
                "UPDATE session_messages SET content_json = json_set(content_json, '{path}', ?2) \
                 WHERE json_valid(content_json) AND json_extract(content_json, '{path}') = ?1"
            ),
            params![duplicate_id, keeper_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn prune_legacy_cloud_self_message_duplicates_in_db(
    conn: &mut Connection,
) -> Result<Vec<String>, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let candidates = {
        let mut statement = tx
            .prepare(
                "SELECT id, session_id, sender_identity_id, sender_role,
                        message_kind, content_text, created_at_ms, sequence_num
                 FROM session_messages
                 WHERE source_transport = 'cloud-self-agent'
                   AND sender_role = 'user'
                   AND message_kind = 'text'
                   AND content_json IS NULL
                 ORDER BY sequence_num ASC, id ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(LegacySelfReplayCandidate {
                    id: row.get(0)?,
                    key: LegacySelfReplayKey {
                        session_id: row.get(1)?,
                        sender_identity_id: row.get(2)?,
                        sender_role: row.get(3)?,
                        message_kind: row.get(4)?,
                        content_text: row.get(5)?,
                    },
                    sequence_num: row.get(7)?,
                    created_at_ms: row.get(6)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    if candidates.len() < 2 {
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(Vec::new());
    }

    let candidate_ids = candidates
        .iter()
        .map(|candidate| candidate.id.clone())
        .collect::<HashSet<_>>();
    let referenced_ids = referenced_canonical_message_ids(&tx, &candidate_ids)?;
    let mut candidates_by_key =
        HashMap::<LegacySelfReplayKey, Vec<LegacySelfReplayCandidate>>::new();
    for candidate in candidates {
        candidates_by_key
            .entry(candidate.key.clone())
            .or_default()
            .push(candidate);
    }

    let mut deleted_ids = Vec::new();
    for candidates in candidates_by_key.values_mut() {
        if candidates.len() < 2 {
            continue;
        }
        candidates.sort_by(|left, right| {
            left.created_at_ms
                .cmp(&right.created_at_ms)
                .then_with(|| left.sequence_num.cmp(&right.sequence_num))
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut cluster_start = 0;
        while cluster_start < candidates.len() {
            let anchor_created_at_ms = candidates[cluster_start].created_at_ms;
            let mut cluster_end = cluster_start + 1;
            while cluster_end < candidates.len()
                && candidates[cluster_end]
                    .created_at_ms
                    .saturating_sub(anchor_created_at_ms)
                    < LEGACY_SELF_REPLAY_WINDOW_MS
            {
                cluster_end += 1;
            }
            let cluster = &candidates[cluster_start..cluster_end];
            if cluster.len() > 1 {
                let keeper_id = cluster
                    .iter()
                    .find(|candidate| referenced_ids.contains(&candidate.id))
                    .or_else(|| cluster.first())
                    .map(|candidate| candidate.id.as_str())
                    .expect("duplicate candidate cluster is non-empty");
                for candidate in cluster {
                    if candidate.id == keeper_id {
                        continue;
                    }
                    repoint_canonical_message_references(&tx, &candidate.id, keeper_id)?;
                    deleted_ids.push(candidate.id.clone());
                }
            }
            cluster_start = cluster_end;
        }
    }

    deleted_ids.sort();
    {
        let mut delete = tx
            .prepare("DELETE FROM session_messages WHERE id = ?1")
            .map_err(|error| error.to_string())?;
        for message_id in &deleted_ids {
            delete
                .execute(params![message_id])
                .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(deleted_ids)
}

pub(crate) fn desktop_canonical_prune_legacy_cloud_self_message_duplicates(
) -> Result<Vec<String>, String> {
    let mut conn = open_db()?;
    prune_legacy_cloud_self_message_duplicates_in_db(&mut conn)
}
