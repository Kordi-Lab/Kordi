use crate::client_config::ClientConfig;
use crate::config::DaemonConfig;
use crate::identity;

use super::{authed_client, load_identity_or_exit, parse_json_or_exit, send_or_exit, DoctorCheck};

#[derive(Debug, Clone)]
struct RegisteredNode {
    node_id: String,
    api_key: String,
}

fn register_node_with_verifying_key(
    coordination: &str,
    verifying_key: &ed25519_dalek::VerifyingKey,
    display_name: Option<&str>,
    runtime: Option<&str>,
) -> Result<RegisteredNode, String> {
    let node_id = identity::derive_node_id(verifying_key);
    let ed_pub = bs58::encode(verifying_key.as_bytes()).into_string();
    let x_pub = hex::encode(
        crate::crypto::ed25519_to_x25519_public(verifying_key.as_bytes())
            .map_err(|err| format!("derive X25519 public key: {}", err))?,
    );
    let name = display_name.unwrap_or(&node_id);

    let client = reqwest::blocking::Client::new();
    let body = serde_json::json!({
        "nodeId": node_id,
        "ed25519Pubkey": ed_pub,
        "x25519Pubkey": x_pub,
        "displayName": name,
        "runtime": runtime,
    });

    let url = format!("{}/v1/auth/register", coordination.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .map_err(|err| format!("reach coordination server: {}", err))?;

    if !resp.status().is_success() {
        return Err(format!("registration failed: HTTP {}", resp.status()));
    }

    let val = resp
        .json::<serde_json::Value>()
        .map_err(|err| format!("parse registration response: {}", err))?;
    let api_key = val["apiKey"]
        .as_str()
        .ok_or_else(|| "server response missing apiKey field".to_string())?
        .to_string();

    Ok(RegisteredNode { api_key, node_id })
}

/// Register with a coordination server and save config.
pub fn cmd_register(coordination: &str, display_name: Option<&str>, runtime: Option<&str>) {
    let (_signing_key, verifying_key) = load_identity_or_exit();
    let name = display_name
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| identity::derive_node_id(&verifying_key));
    let registered =
        register_node_with_verifying_key(coordination, &verifying_key, Some(&name), runtime)
            .unwrap_or_else(|err| {
                eprintln!("Failed to register node: {}", err);
                std::process::exit(1);
            });

    let cfg = ClientConfig {
        coordination: coordination.to_string(),
        node_id: registered.node_id.clone(),
        api_key: registered.api_key,
        display_name: Some(name),
        owner: None,
    };
    cfg.save().unwrap_or_else(|err| {
        eprintln!("Failed to save client config: {}", err);
        std::process::exit(1);
    });
    println!("Registered as {}", registered.node_id);
    println!("Config saved to ~/.bridges/config.json");
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct RemoteIdentityStatus {
    #[serde(rename = "nodeId")]
    pub(crate) node_id: String,
    #[serde(rename = "revokedAt")]
    pub(crate) revoked_at: Option<String>,
    #[serde(rename = "revocationReason")]
    pub(crate) revocation_reason: Option<String>,
    #[serde(rename = "replacementNodeId")]
    pub(crate) replacement_node_id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct RemoteReplaceResp {
    #[serde(rename = "oldNodeId")]
    old_node_id: String,
    #[serde(rename = "newNodeId")]
    new_node_id: String,
    #[serde(rename = "migratedProjectCount")]
    migrated_project_count: i64,
}

pub(crate) fn fetch_remote_identity_status(
    cfg: &ClientConfig,
) -> Result<RemoteIdentityStatus, String> {
    let client = authed_client(cfg);
    let url = format!("{}/v1/auth/me", cfg.coordination);
    let resp = client
        .get(&url)
        .send()
        .map_err(|err| format!("identity status request failed: {}", err))?;
    if !resp.status().is_success() {
        return Err(format!("identity status returned HTTP {}", resp.status()));
    }
    resp.json::<RemoteIdentityStatus>()
        .map_err(|err| format!("failed to parse identity status response: {}", err))
}

pub(crate) fn doctor_identity_check(
    cfg: &ClientConfig,
    remote: &RemoteIdentityStatus,
) -> DoctorCheck {
    if remote.node_id != cfg.node_id {
        return DoctorCheck::error(
            "identity lifecycle",
            format!(
                "local config node {} does not match coordination node {}",
                cfg.node_id, remote.node_id
            ),
            vec![
                "This usually means local identity/config drift after a rotation or partial restore."
                    .to_string(),
                "Run `bridges identity status` and re-run setup or rotation recovery before sending messages."
                    .to_string(),
            ],
        );
    }

    if let Some(revoked_at) = remote.revoked_at.as_deref() {
        let mut hints = vec![
            format!("This node was revoked at {}.", revoked_at),
            "Run `bridges identity rotate` or `bridges setup --coordination <URL>` to establish a new active node."
                .to_string(),
        ];
        if let Some(replacement) = remote.replacement_node_id.as_deref() {
            hints.push(format!(
                "Replacement node recorded by coordination: {}",
                replacement
            ));
        }
        if let Some(reason) = remote.revocation_reason.as_deref() {
            hints.push(format!("Revocation reason: {}", reason));
        }
        return DoctorCheck::error(
            "identity lifecycle",
            format!("coordination reports node {} as revoked", remote.node_id),
            hints,
        );
    }

    DoctorCheck::ok(
        "identity lifecycle",
        format!("coordination reports node {} as active", remote.node_id),
    )
}

pub fn cmd_identity_status() {
    let cfg = ClientConfig::load_or_exit();
    let remote = fetch_remote_identity_status(&cfg).unwrap_or_else(|err| {
        eprintln!("Identity status failed: {}", err);
        std::process::exit(1);
    });

    println!("Current identity:");
    println!("  local node:      {}", cfg.node_id);
    println!("  remote node:     {}", remote.node_id);
    println!("  coordination:    {}", cfg.coordination);
    println!(
        "  display name:    {}",
        cfg.display_name.as_deref().unwrap_or("(none)")
    );
    match remote.revoked_at.as_deref() {
        Some(revoked_at) => {
            println!("  lifecycle state: revoked");
            println!("  revoked at:      {}", revoked_at);
            if let Some(reason) = remote.revocation_reason.as_deref() {
                println!("  revoke reason:   {}", reason);
            }
            if let Some(replacement) = remote.replacement_node_id.as_deref() {
                println!("  replacement:     {}", replacement);
            }
        }
        None => println!("  lifecycle state: active"),
    }
}

pub fn cmd_identity_revoke(reason: Option<&str>) {
    let mut cfg = ClientConfig::load_or_exit();
    let client = authed_client(&cfg);
    let url = format!("{}/v1/auth/revoke", cfg.coordination);
    let body = serde_json::json!({
        "reason": reason,
    });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        eprintln!("Identity revoke failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let remote: RemoteIdentityStatus = parse_json_or_exit(resp);
    cfg.api_key.clear();
    cfg.save().unwrap_or_else(|err| {
        eprintln!(
            "Failed to update local client config after revocation: {}",
            err
        );
        std::process::exit(1);
    });

    println!("Revoked node {}", remote.node_id);
    if let Some(revoked_at) = remote.revoked_at.as_deref() {
        println!("  revoked at: {}", revoked_at);
    }
    if let Ok(message) = crate::service::service_restart() {
        println!("  service: {}", message);
    }
    println!("Local API key was cleared. Run `bridges setup` or `bridges identity rotate` before using this node again.");
}

pub fn cmd_identity_rotate() {
    let mut cfg = ClientConfig::load_or_exit();
    let display_name = cfg.display_name.clone();
    let (_old_signing, old_verifying) = load_identity_or_exit();
    let old_node_id = identity::derive_node_id(&old_verifying);

    println!("Generating replacement identity for {}...", old_node_id);
    let (new_signing, new_verifying) = identity::generate_ephemeral_keypair();
    let runtime_label = DaemonConfig::load().ok().map(|cfg| cfg.runtime);
    let replacement = register_node_with_verifying_key(
        &cfg.coordination,
        &new_verifying,
        display_name.as_deref(),
        runtime_label.as_deref(),
    )
    .unwrap_or_else(|err| {
        eprintln!("Failed to register replacement node: {}", err);
        std::process::exit(1);
    });

    let client = authed_client(&cfg);
    let url = format!("{}/v1/auth/replace", cfg.coordination);
    let body = serde_json::json!({
        "newNodeId": replacement.node_id,
        "newApiKey": replacement.api_key,
        "reason": "rotated_locally",
    });
    let resp = send_or_exit(&client, &url, Some(&body), "POST");
    if !resp.status().is_success() {
        eprintln!("Identity rotate failed: HTTP {}", resp.status());
        std::process::exit(1);
    }
    let replaced: RemoteReplaceResp = parse_json_or_exit(resp);

    identity::replace_keypair(&new_signing).unwrap_or_else(|err| {
        eprintln!("Failed to persist replacement identity: {}", err);
        std::process::exit(1);
    });
    cfg.node_id = replacement.node_id.clone();
    cfg.api_key = replacement.api_key;
    cfg.save().unwrap_or_else(|err| {
        eprintln!("Failed to save rotated client config: {}", err);
        std::process::exit(1);
    });

    println!("Identity rotated successfully");
    println!("  old node: {}", replaced.old_node_id);
    println!("  new node: {}", replaced.new_node_id);
    println!("  migrated projects: {}", replaced.migrated_project_count);
    match crate::service::service_restart() {
        Ok(message) => println!("  service: {}", message),
        Err(err) => eprintln!("  Service restart failed: {}", err),
    }
    println!("Run `bridges doctor` to confirm the replacement node is healthy.");
}

#[cfg(test)]
mod tests {
    use super::super::DoctorLevel;
    use super::*;

    #[test]
    fn doctor_identity_check_reports_revoked_node_as_error() {
        let cfg = ClientConfig {
            coordination: "http://127.0.0.1:17080".to_string(),
            node_id: "kd_old".to_string(),
            api_key: "bridges_sk_test".to_string(),
            display_name: Some("node".to_string()),
            owner: None,
        };
        let remote = RemoteIdentityStatus {
            node_id: "kd_old".to_string(),
            revoked_at: Some("2026-04-17T00:00:00Z".to_string()),
            revocation_reason: Some("compromised".to_string()),
            replacement_node_id: Some("kd_new".to_string()),
        };

        let check = doctor_identity_check(&cfg, &remote);
        assert_eq!(check.level, DoctorLevel::Error);
        assert!(check.summary.contains("revoked"));
        assert!(check.hints.iter().any(|hint| hint.contains("kd_new")));
    }
}
