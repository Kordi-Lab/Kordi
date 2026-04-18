use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_RECENT_EXCHANGES: usize = 6;
const MAX_EXCHANGES_BEFORE_COMPRESSION: usize = 12;
const MAX_SUMMARY_CHARS: usize = 6000;
const MAX_RENDER_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Exchange {
    timestamp: String,
    kind: String,
    peer_message: String,
    local_response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PeerSessionMeta {
    active_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub session_id: String,
    pub active: bool,
    pub exchange_count: usize,
    pub has_summary: bool,
    pub last_timestamp: Option<String>,
}

fn memory_dir(project_dir: &str) -> PathBuf {
    Path::new(project_dir)
        .join(".bridges")
        .join("conversation-memory")
}

fn sanitize_peer_id(peer_id: &str) -> String {
    peer_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn peer_dir(project_dir: &str, peer_id: &str) -> PathBuf {
    memory_dir(project_dir).join(sanitize_peer_id(peer_id))
}

fn meta_path(project_dir: &str, peer_id: &str) -> PathBuf {
    peer_dir(project_dir, peer_id).join("meta.json")
}

fn exchanges_path(project_dir: &str, peer_id: &str, session_id: &str) -> PathBuf {
    peer_dir(project_dir, peer_id).join(format!("{}.jsonl", session_id))
}

fn summary_path(project_dir: &str, peer_id: &str, session_id: &str) -> PathBuf {
    peer_dir(project_dir, peer_id).join(format!("{}.summary.txt", session_id))
}

fn load_meta(project_dir: &str, peer_id: &str) -> PeerSessionMeta {
    let Ok(data) = fs::read_to_string(meta_path(project_dir, peer_id)) else {
        return PeerSessionMeta::default();
    };
    serde_json::from_str(&data).unwrap_or_default()
}

fn save_meta(project_dir: &str, peer_id: &str, meta: &PeerSessionMeta) -> Result<(), String> {
    let dir = peer_dir(project_dir, peer_id);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create peer session dir {}: {}", dir.display(), e))?;
    let path = meta_path(project_dir, peer_id);
    let data =
        serde_json::to_string_pretty(meta).map_err(|e| format!("serialize session meta: {}", e))?;
    fs::write(&path, data).map_err(|e| format!("write session meta {}: {}", path.display(), e))
}

pub fn active_session(project_dir: &str, peer_id: &str) -> Option<String> {
    load_meta(project_dir, peer_id).active_session_id
}

pub fn resolve_session(
    project_dir: &str,
    peer_id: &str,
    requested_session_id: Option<&str>,
    start_new: bool,
) -> Result<String, String> {
    let mut meta = load_meta(project_dir, peer_id);
    let session_id = if let Some(session_id) = requested_session_id {
        session_id.to_string()
    } else if start_new || meta.active_session_id.is_none() {
        format!("sess_{}", uuid::Uuid::new_v4())
    } else {
        meta.active_session_id.clone().unwrap_or_default()
    };
    meta.active_session_id = Some(session_id.clone());
    save_meta(project_dir, peer_id, &meta)?;
    Ok(session_id)
}

pub fn create_session(project_dir: &str, peer_id: &str) -> Result<String, String> {
    resolve_session(project_dir, peer_id, None, true)
}

pub fn use_session(project_dir: &str, peer_id: &str, session_id: &str) -> Result<(), String> {
    let exchanges_file = exchanges_path(project_dir, peer_id, session_id);
    let summary_file = summary_path(project_dir, peer_id, session_id);
    if !exchanges_file.exists() && !summary_file.exists() {
        return Err(format!("session {} not found for {}", session_id, peer_id));
    }
    resolve_session(project_dir, peer_id, Some(session_id), false).map(|_| ())
}

pub fn list_sessions(project_dir: &str, peer_id: &str) -> Result<Vec<SessionInfo>, String> {
    let dir = peer_dir(project_dir, peer_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let active = active_session(project_dir, peer_id);
    let mut sessions = Vec::new();
    let entries =
        fs::read_dir(&dir).map_err(|e| format!("read session dir {}: {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read session dir entry: {}", e))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }
        let session_id = name.trim_end_matches(".jsonl").to_string();
        let exchanges = load_exchanges(&path);
        let last_timestamp = exchanges.last().map(|exchange| exchange.timestamp.clone());
        let summary_file = summary_path(project_dir, peer_id, &session_id);
        let has_summary = fs::read_to_string(&summary_file)
            .map(|content| !content.trim().is_empty())
            .unwrap_or(false);
        sessions.push(SessionInfo {
            active: active.as_deref() == Some(session_id.as_str()),
            exchange_count: exchanges.len(),
            has_summary,
            last_timestamp,
            session_id,
        });
    }

    if let Some(active_session_id) = active {
        if !sessions
            .iter()
            .any(|session| session.session_id == active_session_id)
        {
            let summary_file = summary_path(project_dir, peer_id, &active_session_id);
            sessions.push(SessionInfo {
                session_id: active_session_id,
                active: true,
                exchange_count: 0,
                has_summary: fs::read_to_string(summary_file)
                    .map(|content| !content.trim().is_empty())
                    .unwrap_or(false),
                last_timestamp: None,
            });
        }
    }

    sessions.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then_with(|| b.last_timestamp.cmp(&a.last_timestamp))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    Ok(sessions)
}

pub fn reset_session(project_dir: &str, peer_id: &str, session_id: &str) -> Result<(), String> {
    let exchanges_file = exchanges_path(project_dir, peer_id, session_id);
    let summary_file = summary_path(project_dir, peer_id, session_id);
    if exchanges_file.exists() {
        fs::remove_file(&exchanges_file)
            .map_err(|e| format!("remove session file {}: {}", exchanges_file.display(), e))?;
    }
    if summary_file.exists() {
        fs::remove_file(&summary_file)
            .map_err(|e| format!("remove summary file {}: {}", summary_file.display(), e))?;
    }

    let mut meta = load_meta(project_dir, peer_id);
    if meta.active_session_id.as_deref() == Some(session_id) {
        let next_active = list_sessions(project_dir, peer_id)?
            .into_iter()
            .find(|session| session.session_id != session_id)
            .map(|session| session.session_id);
        meta.active_session_id = next_active;
        save_meta(project_dir, peer_id, &meta)?;
    }
    Ok(())
}

pub fn reset_all_sessions(project_dir: &str, peer_id: &str) -> Result<(), String> {
    let dir = peer_dir(project_dir, peer_id);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("remove peer session dir {}: {}", dir.display(), e))?;
    }
    Ok(())
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = text.chars().take(max_chars).collect();
        format!("{}...", truncated)
    }
}

fn load_exchanges(path: &Path) -> Vec<Exchange> {
    let Ok(data) = fs::read_to_string(path) else {
        return Vec::new();
    };
    data.lines()
        .filter_map(|line| serde_json::from_str::<Exchange>(line).ok())
        .collect()
}

fn write_exchanges(path: &Path, exchanges: &[Exchange]) -> Result<(), String> {
    let mut out = String::new();
    for exchange in exchanges {
        let line =
            serde_json::to_string(exchange).map_err(|e| format!("serialize exchange: {}", e))?;
        out.push_str(&line);
        out.push('\n');
    }
    fs::write(path, out).map_err(|e| format!("write exchanges {}: {}", path.display(), e))
}

fn summarize_exchanges(existing_summary: &str, exchanges: &[Exchange]) -> String {
    let mut lines = Vec::new();
    if !existing_summary.trim().is_empty() {
        lines.push(existing_summary.trim().to_string());
    }
    if !exchanges.is_empty() {
        lines.push("Older conversation summary:".to_string());
        for exchange in exchanges {
            lines.push(format!(
                "- [{} @ {}] Peer said: {} | You replied: {}",
                exchange.kind,
                exchange.timestamp,
                truncate(&exchange.peer_message.replace('\n', " "), 180),
                truncate(&exchange.local_response.replace('\n', " "), 220)
            ));
        }
    }
    let summary = lines.join("\n");
    if summary.chars().count() <= MAX_SUMMARY_CHARS {
        summary
    } else {
        let tail: String = summary
            .chars()
            .rev()
            .take(MAX_SUMMARY_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        format!("...{}", tail)
    }
}

pub fn append_exchange(
    project_dir: &str,
    peer_id: &str,
    session_id: Option<&str>,
    kind: &str,
    peer_message: &str,
    local_response: &str,
) -> Result<(), String> {
    let session_id = resolve_session(project_dir, peer_id, session_id, false)?;
    let dir = peer_dir(project_dir, peer_id);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("create conversation memory dir {}: {}", dir.display(), e))?;

    let exchanges_file = exchanges_path(project_dir, peer_id, &session_id);
    let summary_file = summary_path(project_dir, peer_id, &session_id);
    let mut exchanges = load_exchanges(&exchanges_file);
    exchanges.push(Exchange {
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: kind.to_string(),
        peer_message: peer_message.to_string(),
        local_response: local_response.to_string(),
    });

    let total_chars: usize = exchanges
        .iter()
        .map(|exchange| exchange.peer_message.len() + exchange.local_response.len())
        .sum();

    if exchanges.len() > MAX_EXCHANGES_BEFORE_COMPRESSION || total_chars > 16_000 {
        let split_at = exchanges.len().saturating_sub(MAX_RECENT_EXCHANGES);
        let older = exchanges[..split_at].to_vec();
        let recent = exchanges[split_at..].to_vec();
        let existing_summary = fs::read_to_string(&summary_file).unwrap_or_default();
        let summary = summarize_exchanges(&existing_summary, &older);
        fs::write(&summary_file, summary)
            .map_err(|e| format!("write summary {}: {}", summary_file.display(), e))?;
        write_exchanges(&exchanges_file, &recent)
    } else {
        write_exchanges(&exchanges_file, &exchanges)
    }
}

pub fn render_context(project_dir: &str, peer_id: &str, session_id: Option<&str>) -> String {
    let session_id = match resolve_session(project_dir, peer_id, session_id, false) {
        Ok(session_id) => session_id,
        Err(_) => return String::new(),
    };
    let summary =
        fs::read_to_string(summary_path(project_dir, peer_id, &session_id)).unwrap_or_default();
    let exchanges = load_exchanges(&exchanges_path(project_dir, peer_id, &session_id));

    let mut sections = Vec::new();
    sections.push(format!("Session ID: {}", session_id));
    if !summary.trim().is_empty() {
        sections.push(format!("Summary:\n{}", summary.trim()));
    }

    if !exchanges.is_empty() {
        let mut recent = String::from("Recent exchanges:\n");
        for exchange in exchanges.iter().rev().take(MAX_RECENT_EXCHANGES).rev() {
            recent.push_str(&format!(
                "- [{}] Peer: {}\n  You: {}\n",
                exchange.kind,
                truncate(&exchange.peer_message.replace('\n', " "), 240),
                truncate(&exchange.local_response.replace('\n', " "), 280)
            ));
        }
        sections.push(recent.trim_end().to_string());
    }

    let rendered = sections.join("\n\n");
    if rendered.chars().count() <= MAX_RENDER_CHARS {
        rendered
    } else {
        truncate(&rendered, MAX_RENDER_CHARS)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        active_session, append_exchange, create_session, list_sessions, render_context,
        reset_all_sessions, reset_session, resolve_session, use_session,
    };

    #[test]
    fn compresses_old_exchanges_into_summary() {
        let base = std::env::temp_dir().join(format!(
            "bridges-conversation-memory-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(base.join(".bridges")).unwrap();
        let project_dir = base.to_string_lossy().to_string();

        for i in 0..14 {
            append_exchange(
                &project_dir,
                "kd_peer",
                None,
                "ask",
                &format!("question {}", i),
                &format!("answer {}", i),
            )
            .unwrap();
        }

        let context = render_context(&project_dir, "kd_peer", None);
        assert!(context.contains("Summary:"));
        assert!(context.contains("Recent exchanges:"));
        assert!(context.contains("question 13"));

        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn new_session_replaces_active_session_but_defaults_to_existing() {
        let base = std::env::temp_dir().join(format!(
            "bridges-conversation-memory-session-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(base.join(".bridges")).unwrap();
        let project_dir = base.to_string_lossy().to_string();

        let first = resolve_session(&project_dir, "kd_peer", None, false).unwrap();
        let again = resolve_session(&project_dir, "kd_peer", None, false).unwrap();
        assert_eq!(first, again);

        let second = resolve_session(&project_dir, "kd_peer", None, true).unwrap();
        assert_ne!(first, second);

        let latest = resolve_session(&project_dir, "kd_peer", None, false).unwrap();
        assert_eq!(second, latest);

        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn can_list_switch_and_reset_sessions() {
        let base = std::env::temp_dir().join(format!(
            "bridges-conversation-memory-admin-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(base.join(".bridges")).unwrap();
        let project_dir = base.to_string_lossy().to_string();

        let first = create_session(&project_dir, "kd_peer").unwrap();
        append_exchange(&project_dir, "kd_peer", Some(&first), "ask", "q1", "a1").unwrap();

        let second = create_session(&project_dir, "kd_peer").unwrap();
        append_exchange(&project_dir, "kd_peer", Some(&second), "ask", "q2", "a2").unwrap();

        let sessions = list_sessions(&project_dir, "kd_peer").unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, second);
        assert!(sessions[0].active);

        use_session(&project_dir, "kd_peer", &first).unwrap();
        assert_eq!(
            active_session(&project_dir, "kd_peer").as_deref(),
            Some(first.as_str())
        );

        reset_session(&project_dir, "kd_peer", &first).unwrap();
        let sessions = list_sessions(&project_dir, "kd_peer").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, second);

        reset_all_sessions(&project_dir, "kd_peer").unwrap();
        assert!(list_sessions(&project_dir, "kd_peer").unwrap().is_empty());

        std::fs::remove_dir_all(base).ok();
    }
}
