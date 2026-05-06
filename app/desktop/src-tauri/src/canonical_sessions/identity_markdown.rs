use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};

use super::{canonical_storage_root, hash_hex, IdentityContextRequest};

const SESSION_IDENTITY_DIR: &str = "session-identities";
const IDENTITY_MARKDOWN_VERSION: &str = "v1";

pub(crate) fn session_identity_markdown_path(session_id: &str) -> PathBuf {
    let trimmed = session_id.trim();
    let safe = safe_file_stem(trimmed);
    let digest = hash_hex(trimmed, 8);
    identity_markdown_storage_root()
        .join(SESSION_IDENTITY_DIR)
        .join(format!("{safe}-{digest}.md"))
}

pub(crate) fn session_identity_model_visible_notice(
    visible_text: &str,
    session_id: &str,
    path: &Path,
) -> String {
    format!(
        "{}\nIdentity file changed for session {}.\nSession identity file: {}",
        visible_text.trim(),
        session_id.trim(),
        path.display()
    )
}

pub(crate) fn identity_file_changed_content_fields(
    session_id: &str,
    path: &Path,
) -> serde_json::Value {
    serde_json::json!({
        "identityFileChanged": true,
        "identityFileSessionId": session_id.trim(),
        "identityFilePath": path.display().to_string()
    })
}

pub(crate) fn render_identity_context_markdown(
    input: &IdentityContextRequest,
    updated_at: &str,
    participant_graph_hash: Option<&str>,
    permission_policy_hash: Option<&str>,
) -> String {
    let mut out = String::new();
    out.push_str("# Kordi Session Identity Context\n\n");
    out.push_str("Version: ");
    out.push_str(IDENTITY_MARKDOWN_VERSION);
    out.push('\n');
    push_optional_header(&mut out, "Session ID", input.session_id.as_deref());
    push_optional_header(&mut out, "Session kind", input.session_kind.as_deref());
    push_optional_header(&mut out, "Project name", input.project_name.as_deref());
    out.push_str("Updated at: ");
    out.push_str(&markdown_scalar(updated_at));
    out.push('\n');
    push_optional_header(&mut out, "Participant graph hash", participant_graph_hash);
    push_optional_header(&mut out, "Permission policy hash", permission_policy_hash);

    out.push_str("\n## Current model / self\n\n");
    push_role(
        &mut out,
        &input.self_identity,
        Some(&input.permissions.reply_as_identity_id),
    );

    out.push_str("\n## Requester / initiator\n\n");
    if let Some(requester) = input.requester.as_ref() {
        push_role(&mut out, requester, None);
    } else {
        out.push_str("- none\n");
    }

    out.push_str("\n## Current target\n\n");
    if let Some(target) = input.target.as_ref() {
        push_role(&mut out, target, None);
    } else {
        out.push_str("- none\n");
    }

    out.push_str("\n## Participants\n\n");
    out.push_str("| identityId | displayName | kind | role | owner | locality | bridgeNodeId | humanId | agentId | runtime |\n");
    out.push_str("|---|---|---|---|---|---|---|---|---|---|\n");
    let mut participants = input.participants.clone();
    participants.sort_by(|left, right| {
        markdown_scalar(&left.identity_id)
            .cmp(&markdown_scalar(&right.identity_id))
            .then_with(|| markdown_scalar(&left.kind).cmp(&markdown_scalar(&right.kind)))
            .then_with(|| {
                markdown_scalar(&left.display_name).cmp(&markdown_scalar(&right.display_name))
            })
    });
    for participant in participants {
        out.push_str("| ");
        out.push_str(&markdown_table_cell(&participant.identity_id));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&participant.display_name));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&participant.kind));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&markdown_participant_role(
            &participant.role,
        )));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(&owner_label(
            participant.owner_display_name.as_deref(),
            participant.owner_identity_id.as_deref(),
        )));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(
            participant.locality.as_deref().unwrap_or(""),
        ));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(
            participant.bridge_node_id.as_deref().unwrap_or(""),
        ));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(
            participant.human_id.as_deref().unwrap_or(""),
        ));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(
            participant.agent_id.as_deref().unwrap_or(""),
        ));
        out.push_str(" | ");
        out.push_str(&markdown_table_cell(
            participant.runtime.as_deref().unwrap_or(""),
        ));
        out.push_str(" |\n");
    }

    out.push_str("\n## Permissions\n\n");
    out.push_str("- mayImpersonate: none\n");
    if input.permissions.reach_out_allowed && !input.permissions.allowed_targets.is_empty() {
        out.push_str("- reachOut: allowed only for explicit non-local @Person/@Agent mentions in the current user message\n");
    } else {
        out.push_str("- reachOut: disabled; ask the local user when a non-local target is ambiguous or not permitted\n");
    }
    out.push_str("- allowedTargets:\n");
    let mut targets = input
        .permissions
        .allowed_targets
        .iter()
        .map(|target| markdown_scalar(target))
        .filter(|target| !target.is_empty())
        .collect::<Vec<_>>();
    targets.sort();
    targets.dedup();
    if targets.is_empty() {
        out.push_str("  - none\n");
    } else {
        for target in targets {
            out.push_str("  - ");
            out.push_str(&target);
            out.push('\n');
        }
    }
    out.push_str("- contextPolicy: ");
    out.push_str(&markdown_scalar(&input.permissions.context_policy));
    out.push('\n');
    out.push_str("- requiresApproval: ");
    out.push_str(if input.permissions.requires_approval {
        "true"
    } else {
        "false"
    });
    out.push('\n');

    out.push_str("\n## Rules\n\n");
    out.push_str("- Reply only as the `replyAs` identity.\n");
    out.push_str("- Do not impersonate any other person or agent.\n");
    out.push_str("- Do not prefix replies with speaker labels or identity names.\n");
    out.push_str(
        "- Treat canonical identity IDs as authoritative; display names are descriptive only.\n",
    );
    out.push_str("- Use the current message author/requester to interpret “I”, “me”, and “my”.\n");
    out.push_str("- Do not contact or delegate to another person or agent unless the current user explicitly mentioned that non-local participant and permissions allow it.\n");
    out
}

pub(crate) fn write_identity_context_markdown(
    input: &IdentityContextRequest,
    participant_graph_hash: Option<&str>,
    permission_policy_hash: Option<&str>,
) -> Result<PathBuf, String> {
    let session_id = input
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Identity Markdown requires a session id".to_string())?;
    let path = session_identity_markdown_path(session_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let updated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let markdown = render_identity_context_markdown(
        input,
        &updated_at,
        participant_graph_hash,
        permission_policy_hash,
    );
    let tmp_path = path.with_extension("md.tmp");
    std::fs::write(&tmp_path, markdown).map_err(|err| err.to_string())?;
    std::fs::rename(&tmp_path, &path).map_err(|err| err.to_string())?;
    Ok(path)
}

fn identity_markdown_storage_root() -> PathBuf {
    #[cfg(test)]
    if let Some(path) = super::CANONICAL_SESSIONS_TEST_DB_PATH
        .with(|current| current.borrow().clone())
        .and_then(|path| path.parent().map(Path::to_path_buf))
    {
        return path;
    }

    canonical_storage_root()
}

fn safe_file_stem(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 64 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

fn push_optional_header(out: &mut String, label: &str, value: Option<&str>) {
    let value = value.map(markdown_scalar).unwrap_or_default();
    if !value.is_empty() {
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&value);
        out.push('\n');
    }
}

fn push_role(out: &mut String, role: &super::IdentityContextRole, reply_as: Option<&str>) {
    out.push_str("- identityId: ");
    out.push_str(&markdown_scalar(&role.identity_id));
    out.push('\n');
    out.push_str("- displayName: ");
    out.push_str(&markdown_scalar(&role.display_name));
    out.push('\n');
    out.push_str("- kind: ");
    out.push_str(&markdown_scalar(&role.kind));
    out.push('\n');
    let owner = owner_label(
        role.owner_display_name.as_deref(),
        role.owner_identity_id.as_deref(),
    );
    if !owner.is_empty() {
        out.push_str("- owner: ");
        out.push_str(&markdown_scalar(&owner));
        out.push('\n');
    }
    if let Some(locality) = role
        .locality
        .as_deref()
        .map(markdown_scalar)
        .filter(|value| !value.is_empty())
    {
        out.push_str("- locality: ");
        out.push_str(&locality);
        out.push('\n');
    }
    if let Some(reply_as) = reply_as {
        out.push_str("- replyAs: ");
        out.push_str(&markdown_scalar(reply_as));
        out.push_str(" only\n");
    }
}

fn owner_label(owner_display_name: Option<&str>, owner_identity_id: Option<&str>) -> String {
    match (
        owner_display_name
            .map(markdown_scalar)
            .filter(|value| !value.is_empty()),
        owner_identity_id
            .map(markdown_scalar)
            .filter(|value| !value.is_empty()),
    ) {
        (Some(display), Some(identity_id)) => format!("{display} ({identity_id})"),
        (None, Some(identity_id)) => identity_id,
        _ => String::new(),
    }
}

fn markdown_participant_role(role: &str) -> String {
    match markdown_scalar(role).as_str() {
        "" | "person" | "delegate" => "participant".to_string(),
        role => role.to_string(),
    }
}

fn markdown_table_cell(value: &str) -> String {
    markdown_scalar(value).replace('|', "\\|")
}

fn markdown_scalar(value: &str) -> String {
    let mut cleaned = String::new();
    let mut last_was_space = false;
    for ch in value.trim().chars() {
        if ch.is_control() || ch.is_whitespace() {
            if !last_was_space {
                cleaned.push(' ');
                last_was_space = true;
            }
            continue;
        }
        match ch {
            '<' => cleaned.push_str("&lt;"),
            '>' => cleaned.push_str("&gt;"),
            _ => cleaned.push(ch),
        }
        last_was_space = false;
    }
    cleaned.trim().to_string()
}
