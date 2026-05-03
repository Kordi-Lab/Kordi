use base64::Engine as _;

use crate::client_config::ClientConfig;
use crate::identity;

use super::{
    authed_client, load_identity_or_exit, open_local_db_or_exit, parse_json_or_exit,
    require_project_id, send_or_exit,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ShareableInvite {
    #[serde(rename = "v")]
    version: u8,
    coordination: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(rename = "inviteToken")]
    invite_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedInvite {
    coordination: Option<String>,
    project_id: String,
    invite_token: String,
}

fn encode_shareable_invite(
    coordination: &str,
    project_id: &str,
    invite_token: &str,
) -> Result<String, String> {
    let payload = ShareableInvite {
        version: 1,
        coordination: coordination.trim_end_matches('/').to_string(),
        project_id: project_id.to_string(),
        invite_token: invite_token.to_string(),
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|err| format!("failed to encode shareable invite payload: {}", err))?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    Ok(format!("bridges://join/{}", encoded))
}

fn decode_shareable_invite(value: &str) -> Result<Option<ShareableInvite>, String> {
    let trimmed = value.trim();
    let Some(encoded) = trimmed.strip_prefix("bridges://join/") else {
        return Ok(None);
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|err| format!("invalid shareable invite encoding: {}", err))?;
    let invite: ShareableInvite = serde_json::from_slice(&bytes)
        .map_err(|err| format!("invalid shareable invite payload: {}", err))?;
    if invite.version != 1 {
        return Err(format!(
            "unsupported shareable invite version {}",
            invite.version
        ));
    }
    if invite.project_id.trim().is_empty() || invite.invite_token.trim().is_empty() {
        return Err("shareable invite is missing project or token data".to_string());
    }
    Ok(Some(invite))
}

fn resolve_join_invite(invite: &str, project_id: Option<&str>) -> Result<ResolvedInvite, String> {
    if let Some(bundle) = decode_shareable_invite(invite)? {
        if let Some(project_id) = project_id.filter(|value| !value.trim().is_empty()) {
            if project_id != bundle.project_id {
                return Err(format!(
                    "shareable invite targets project {}, but --project was {}",
                    bundle.project_id, project_id
                ));
            }
        }
        return Ok(ResolvedInvite {
            coordination: Some(bundle.coordination),
            project_id: bundle.project_id,
            invite_token: bundle.invite_token,
        });
    }

    let Some(project_id) = project_id.filter(|value| !value.trim().is_empty()) else {
        return Err(
            "raw invite tokens still require --project, or use the full `bridges://join/...` invite string"
                .to_string(),
        );
    };
    Ok(ResolvedInvite {
        coordination: None,
        project_id: project_id.to_string(),
        invite_token: invite.trim().to_string(),
    })
}

/// Create a project on the coordination server + local directory.
pub fn cmd_create(name: &str, description: Option<&str>) {
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let body = serde_json::json!({
        "slug": name,
        "displayName": name,
        "description": description,
    });
    let url = format!("{}/v1/projects", cfg.coordination);
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        if resp.status().as_u16() == 409 {
            eprintln!(
                "Project '{}' already exists. Use a different name, or invite collaborators with:",
                name
            );
            eprintln!("  bridges invite -p <project_id>");
            eprintln!("Run 'bridges status' to see your existing projects.");
        } else {
            eprintln!("Create failed: HTTP {}", resp.status());
        }
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    let project_id = val["projectId"].as_str().unwrap_or("?");

    // Create local project directory at ~/bridges-projects/<slug>/
    let project_dir = crate::queries::project_dir_for_slug(name);
    std::fs::create_dir_all(&project_dir).ok();

    // Initialize local workspace metadata and optional shared workspace files.
    crate::workspace::init_workspace(&project_dir, name).unwrap_or_else(|err| {
        eprintln!("Failed to initialize workspace: {}", err);
        std::process::exit(1);
    });
    crate::sync_engine::init_shared(&project_dir);

    // Store in local DB with path
    let conn = open_local_db_or_exit();
    crate::queries::insert_project(
        &conn,
        &crate::models::Project {
            project_id: project_id.to_string(),
            slug: name.to_string(),
            display_name: Some(name.to_string()),
            description: description.map(|d| d.to_string()),
            project_path: Some(project_dir.to_string_lossy().to_string()),
            owner_principal_id: None,
            status: "active".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    );

    // Write initial MEMBERS.md (creator as owner)
    let now = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let (_, vk) = load_identity_or_exit();
    let my_node = identity::derive_node_id(&vk);
    crate::sync_engine::update_members(&project_dir, &[(my_node, "owner".to_string(), now)]);

    println!("Project created: {}", project_id);
    println!("  path: {}", project_dir.display());
}

/// Generate a shareable invite for a project.
pub fn cmd_invite(project_id: &str) {
    require_project_id(project_id);
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/projects/{}/invites", cfg.coordination, project_id);
    let body = serde_json::json!({ "maxUses": 10 });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        eprintln!("Invite failed: HTTP {} — {}", status, text);
        eprintln!("URL: {}", url);
        std::process::exit(1);
    }
    let val: serde_json::Value = parse_json_or_exit(resp);
    let invite_token = val["inviteToken"].as_str().unwrap_or("?");
    let shareable = encode_shareable_invite(&cfg.coordination, project_id, invite_token)
        .unwrap_or_else(|err| {
            eprintln!("Failed to build shareable invite: {}", err);
            std::process::exit(1);
        });

    println!("Invite created for {}", project_id);
    println!("\nShare this with your collaborator:");
    println!("  {}", shareable);
    println!("\nJoin command:");
    println!("  bridges join '{}'", shareable);
    println!("\nUnderlying token flow (still supported):");
    println!("  project: {}", project_id);
    println!("  token:   {}", invite_token);
}

/// Join a project with a shareable invite string or raw token + project.
pub fn cmd_join(invite: &str, project_id: Option<&str>) {
    let invite = resolve_join_invite(invite, project_id).unwrap_or_else(|err| {
        eprintln!("Join failed: {}", err);
        std::process::exit(1);
    });
    require_project_id(&invite.project_id);

    let cfg = match ClientConfig::load() {
        Ok(Some(cfg)) => cfg,
        Ok(None) => {
            if let Some(coordination) = invite.coordination.as_deref() {
                eprintln!(
                    "Not registered. Run `bridges setup --coordination {}` before joining this invite.",
                    coordination
                );
            } else {
                eprintln!(
                    "Not registered. Run `bridges setup --coordination <url>` before joining this invite."
                );
            }
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("Failed to load client config: {}", err);
            std::process::exit(1);
        }
    };

    if let Some(coordination) = invite.coordination.as_deref() {
        if cfg.coordination.trim_end_matches('/') != coordination.trim_end_matches('/') {
            eprintln!(
                "Join failed: invite targets coordination {}, but this node is registered against {}.",
                coordination, cfg.coordination
            );
            eprintln!(
                "Run `bridges setup --coordination {}` on the correct server, then retry the invite.",
                coordination
            );
            std::process::exit(1);
        }
    }

    let client = authed_client(&cfg);
    let url = format!(
        "{}/v1/projects/{}/join",
        cfg.coordination, invite.project_id
    );
    let body = serde_json::json!({
        "inviteToken": invite.invite_token,
        "agentRole": "member",
    });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        eprintln!("Join failed: HTTP {}", resp.status());
        std::process::exit(1);
    }

    // Fetch project details to get the slug.
    let details_url = format!("{}/v1/projects/{}", cfg.coordination, invite.project_id);
    let slug = match client.get(&details_url).send() {
        Ok(resp) if resp.status().is_success() => {
            let val: serde_json::Value = resp.json().unwrap_or_default();
            val["slug"]
                .as_str()
                .unwrap_or(&invite.project_id)
                .to_string()
        }
        _ => invite.project_id.replace("proj_", ""),
    };

    // Check if project directory already exists locally
    let conn = open_local_db_or_exit();
    let project_dir = if let Some(existing) = crate::queries::get_project_path_by_slug(&conn, &slug)
    {
        std::path::PathBuf::from(existing)
    } else {
        let dir = crate::queries::project_dir_for_slug(&slug);
        std::fs::create_dir_all(&dir).ok();
        dir
    };

    // Initialize local workspace metadata and optional shared workspace files.
    crate::workspace::init_workspace(&project_dir, &slug).unwrap_or_else(|err| {
        eprintln!("Failed to initialize workspace: {}", err);
        std::process::exit(1);
    });
    crate::sync_engine::init_shared(&project_dir);

    // Store in local DB
    crate::queries::insert_project(
        &conn,
        &crate::models::Project {
            project_id: invite.project_id.to_string(),
            slug: slug.clone(),
            display_name: Some(slug.clone()),
            description: None,
            project_path: Some(project_dir.to_string_lossy().to_string()),
            owner_principal_id: None,
            status: "active".to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    );

    // Fetch and write MEMBERS.md
    let members_url = format!(
        "{}/v1/projects/{}/members",
        cfg.coordination, invite.project_id
    );
    if let Ok(resp) = client.get(&members_url).send() {
        if let Ok(members) = resp.json::<Vec<serde_json::Value>>() {
            let member_list: Vec<(String, String, String)> = members
                .iter()
                .map(|m| {
                    let nid = m["nodeId"].as_str().unwrap_or("?").to_string();
                    let role = m["agentRole"].as_str().unwrap_or("member").to_string();
                    let joined = m["joinedAt"].as_str().unwrap_or("?").to_string();
                    (nid, role, joined)
                })
                .collect();
            crate::sync_engine::update_members(&project_dir, &member_list);
        }
    }

    println!("Joined project {}", invite.project_id);
    println!("  path: {}", project_dir.display());
}

/// List members of a project.
pub fn cmd_members(project_id: &str) {
    require_project_id(project_id);
    let cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/projects/{}/members", cfg.coordination, project_id);
    let resp = send_or_exit(&client, &url, None, "GET");
    if !resp.status().is_success() {
        eprintln!("Members failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let members: Vec<serde_json::Value> = parse_json_or_exit(resp);
    println!("Members of {}:", project_id);
    for m in &members {
        let name = m["displayName"].as_str().unwrap_or("?");
        let role = m["agentRole"].as_str().unwrap_or("member");
        let nid = m["nodeId"].as_str().unwrap_or("?");
        println!("  {} ({}) [{}]", nid, name, role);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shareable_invite_round_trips() {
        let encoded =
            encode_shareable_invite("http://127.0.0.1:17080/", "proj_test", "bridges_inv_test")
                .unwrap();
        let decoded = decode_shareable_invite(&encoded).unwrap().unwrap();
        assert_eq!(decoded.version, 1);
        assert_eq!(decoded.coordination, "http://127.0.0.1:17080");
        assert_eq!(decoded.project_id, "proj_test");
        assert_eq!(decoded.invite_token, "bridges_inv_test");
    }

    #[test]
    fn resolve_join_invite_accepts_shareable_string_without_project_flag() {
        let encoded =
            encode_shareable_invite("http://127.0.0.1:17080", "proj_test", "bridges_inv_test")
                .unwrap();
        let invite = resolve_join_invite(&encoded, None).unwrap();
        assert_eq!(invite.project_id, "proj_test");
        assert_eq!(invite.invite_token, "bridges_inv_test");
        assert_eq!(
            invite.coordination.as_deref(),
            Some("http://127.0.0.1:17080")
        );
    }

    #[test]
    fn resolve_join_invite_rejects_mismatched_project_flag() {
        let encoded =
            encode_shareable_invite("http://127.0.0.1:17080", "proj_test", "bridges_inv_test")
                .unwrap();
        let err = resolve_join_invite(&encoded, Some("proj_other")).unwrap_err();
        assert!(err.contains("targets project proj_test"));
    }

    #[test]
    fn resolve_join_invite_requires_project_for_raw_token() {
        let err = resolve_join_invite("bridges_inv_test", None).unwrap_err();
        assert!(err.contains("raw invite tokens still require --project"));
    }
}
