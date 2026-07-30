use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::config::DaemonConfig;
use crate::connmgr::ConnManager;
use crate::coord_client::{CoordClient, EndpointHint, MemberInfo, PeerKeys};
use crate::derp_client::DerpClient;
use crate::identity;
use crate::listener::dispatch;
use crate::local_api;
use crate::mdns;
use crate::presence::PresenceState;
use crate::stun;
use crate::transport::Transport;

mod inbound;
mod mailbox;
mod peer_identities;

use inbound::InboundLoopContext;
use mailbox::MailboxLoopContext;
use peer_identities::sync_transport_identities_from_projects;

fn resolve_runtime_project_dir(project_id: &str, fallback: &str) -> String {
    if !project_id.is_empty() {
        if let Ok(conn) = crate::db::open_db() {
            if crate::db::init_db(&conn).is_ok() {
                if let Some(path) = crate::queries::get_project_path(&conn, project_id) {
                    return path;
                }
            }
        }
    }
    fallback.to_string()
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch_inbound_message(
    coord: &CoordClient,
    runtime_type: &str,
    runtime_endpoint: &str,
    fallback_project_dir: &str,
    from: &str,
    project_id: &str,
    kind: &str,
    session_id: Option<&str>,
    payload: &serde_json::Value,
) -> Result<String, String> {
    let project_dir = resolve_runtime_project_dir(project_id, fallback_project_dir);
    let runtime = dispatch::create_runtime(runtime_type, runtime_endpoint, &project_dir)?;
    let sender = if project_id.is_empty() {
        None
    } else {
        coord
            .get_project_members(project_id)
            .await
            .ok()
            .and_then(|members| {
                members
                    .into_iter()
                    .find(|member: &MemberInfo| member.node_id == from)
            })
    };
    let sandbox = dispatch::create_sandbox(
        &project_dir,
        from,
        sender
            .as_ref()
            .and_then(|member| member.display_name.as_deref()),
        sender.as_ref().and_then(|member| member.role.as_deref()),
        project_id,
        kind,
        session_id,
        payload,
    );
    let response = dispatch::dispatch_message(runtime.as_ref(), &sandbox).await?;
    let _ = crate::conversation_memory::append_exchange(
        &project_dir,
        from,
        session_id,
        kind,
        &sandbox.query,
        &response,
    );
    Ok(response)
}

pub(super) async fn decode_mailbox_blob(
    coord: &CoordClient,
    my_node_id: &str,
    my_x25519_priv: &[u8; 32],
    from_node_id: &str,
    project_id: Option<&str>,
    blob: &str,
) -> Result<Vec<u8>, String> {
    let keys = if let Some(project_id) = project_id {
        coord
            .get_peer_keys_in_project(from_node_id, project_id)
            .await?
    } else {
        coord.get_peer_keys(from_node_id).await?
    };
    let decoded = hex::decode(&keys.x25519_pub).map_err(|e| format!("bad x25519 pubkey: {}", e))?;
    if decoded.len() != 32 {
        return Err("x25519 pubkey wrong length".to_string());
    }
    let mut x_pub = [0u8; 32];
    x_pub.copy_from_slice(&decoded);
    match crate::crypto::decrypt_mailbox_payload(
        my_node_id,
        from_node_id,
        my_x25519_priv,
        &x_pub,
        blob,
    ) {
        Ok(plaintext) => Ok(plaintext),
        Err(encrypted_err) => {
            use base64::Engine;
            let plaintext = base64::engine::general_purpose::STANDARD
                .decode(blob)
                .map_err(|_| format!("mailbox decrypt failed: {}", encrypted_err))?;
            eprintln!(
                "  mailbox warning: accepted legacy plaintext relay from {}",
                from_node_id
            );
            Ok(plaintext)
        }
    }
}

pub(super) async fn encode_mailbox_blob(
    coord: &CoordClient,
    from_node_id: &str,
    my_x25519_priv: &[u8; 32],
    target_node_id: &str,
    project_id: Option<&str>,
    plaintext: &[u8],
) -> Result<String, String> {
    let keys = if let Some(project_id) = project_id {
        coord
            .get_peer_keys_in_project(target_node_id, project_id)
            .await?
    } else {
        coord.get_peer_keys(target_node_id).await?
    };
    let decoded = hex::decode(&keys.x25519_pub).map_err(|e| format!("bad x25519 pubkey: {}", e))?;
    if decoded.len() != 32 {
        return Err("x25519 pubkey wrong length".to_string());
    }
    let mut x_pub = [0u8; 32];
    x_pub.copy_from_slice(&decoded);
    crate::crypto::encrypt_mailbox_payload(
        from_node_id,
        target_node_id,
        my_x25519_priv,
        &x_pub,
        plaintext,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn send_delivery_event(
    transport: &Transport,
    coord: &CoordClient,
    from_node_id: &str,
    my_x25519_priv: &[u8; 32],
    target_node_id: &str,
    project_id: &str,
    request_id: &str,
    stage: &str,
    error: Option<&str>,
) {
    if request_id.is_empty() {
        return;
    }

    let event = serde_json::json!({
        "from": from_node_id,
        "projectId": project_id,
        "messageType": "delivery_event",
        "requestId": request_id,
        "payload": {
            "stage": stage,
            "error": error,
        },
    });
    let event_bytes = serde_json::to_vec(&event).unwrap_or_default();
    if let Err(send_err) = transport.send(target_node_id, &event_bytes).await {
        eprintln!(
            "  failed to send delivery event {} to {}: {}",
            stage, target_node_id, send_err
        );
        let project_ref = if project_id.trim().is_empty() {
            None
        } else {
            Some(project_id)
        };
        match encode_mailbox_blob(
            coord,
            from_node_id,
            my_x25519_priv,
            target_node_id,
            project_ref,
            &event_bytes,
        )
        .await
        {
            Ok(event_blob) => {
                if let Err(relay_err) = coord
                    .relay_message(target_node_id, &event_blob, project_ref)
                    .await
                {
                    eprintln!(
                        "  failed to relay delivery event {} to {}: {}",
                        stage, target_node_id, relay_err
                    );
                }
            }
            Err(encode_err) => eprintln!(
                "  failed to encrypt delivery event {} to {}: {}",
                stage, target_node_id, encode_err
            ),
        }
    }
}

/// Run the Bridges daemon. Blocks until interrupted.
pub async fn run(_foreground: bool) -> Result<(), String> {
    let (signing_key, verifying_key) =
        identity::load_or_create_keypair().map_err(|err| format!("load identity: {}", err))?;
    let node_id = identity::derive_node_id(&verifying_key);
    let keypair = identity::NodeKeypair {
        signing: signing_key.clone(),
    };

    let cfg = DaemonConfig::load().map_err(|err| format!("load daemon config: {}", err))?;
    println!("Bridges daemon starting: {}", node_id);

    // Derive X25519 keys
    let x_priv = identity::x25519_private_key(&keypair);
    let api_key = cfg
        .api_key()
        .map_err(|err| format!("load API key: {}", err))?;
    if api_key.is_empty() {
        return Err("Not registered. Run `bridges setup` or `bridges register` first.".to_string());
    }

    // Connect to coordination server using the existing API key from ~/.bridges/config.json.
    // Do not call /v1/auth/register here: that endpoint rotates the node's API key.
    let coord = CoordClient::new(&cfg.coordination_url, &api_key);
    println!("  coordination auth: configured API key");

    // STUN: discover reflexive address
    let mut hints: Vec<EndpointHint> = Vec::new();
    for server in &cfg.stun_servers {
        match stun::get_reflexive_addr(server).await {
            Ok(addr) => {
                println!("  reflexive address: {}", addr);
                hints.push(EndpointHint {
                    addr: addr.to_string(),
                    hint_type: "stun".to_string(),
                });
            }
            Err(e) => eprintln!("  STUN {} failed: {}", server, e),
        }
    }
    let presence = Arc::new(Mutex::new(PresenceState::new(hints.len(), false)));
    if !hints.is_empty() {
        match coord.push_endpoint_hints(&hints).await {
            Ok(()) => {
                presence
                    .lock()
                    .await
                    .note_coord_ok(format!("published {} endpoint hints", hints.len()));
            }
            Err(err) => {
                presence
                    .lock()
                    .await
                    .note_coord_error(format!("push endpoint hints failed: {}", err));
            }
        }
    }

    // mDNS announcement
    mdns::announce(&node_id, cfg.local_api_port);

    // DERP WebSocket
    let derp = if cfg.derp_enabled {
        let derp_url = format!("{}/ws/derp", cfg.coordination_url);
        match DerpClient::connect(&derp_url, &api_key).await {
            Ok(client) => {
                println!("  DERP relay connected");
                presence.lock().await.note_coord_ok("DERP relay connected");
                Some(client)
            }
            Err(e) => {
                eprintln!("  DERP connect failed: {}", e);
                presence
                    .lock()
                    .await
                    .note_coord_error(format!("DERP connect failed: {}", e));
                None
            }
        }
    } else {
        None
    };

    // Build transport
    let conn_mgr = ConnManager::new(Some(coord.clone()));
    {
        let mut snapshot = presence.lock().await;
        snapshot.set_reachability_inputs(hints.len(), derp.is_some());
    }

    let transport = Transport::new(conn_mgr, derp, node_id.clone(), x_priv).await?;
    let transport = Arc::new(transport);
    let (prewarmed, pruned) =
        sync_transport_identities_from_projects(transport.as_ref(), &coord, &node_id).await;
    if prewarmed > 0 || pruned > 0 {
        println!(
            "  transport identity sync: prewarmed {} peers, pruned {} stale peers",
            prewarmed, pruned
        );
    }

    println!("  runtime: {} ({})", cfg.runtime, cfg.runtime);

    // Shared response store (read by CLI via /response/:id endpoint)
    let responses: Arc<Mutex<HashMap<String, local_api::PendingResponse>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Local API state
    let api_state = Arc::new(local_api::ApiState {
        transport: transport.clone(),
        coord: Arc::new(coord.clone()),
        node_id: node_id.clone(),
        my_x25519_priv: x_priv,
        responses: responses.clone(),
        presence: presence.clone(),
    });

    // Start local API server
    let api_port = cfg.local_api_port;
    let api_handle = tokio::spawn(async move {
        if let Err(e) = local_api::serve(api_state, api_port).await {
            eprintln!("Local API error: {}", e);
        }
    });

    let recv_handle = inbound::spawn(InboundLoopContext {
        transport: transport.clone(),
        node_id: node_id.clone(),
        responses: responses.clone(),
        runtime_type: cfg.runtime.clone(),
        runtime_endpoint: cfg.runtime_endpoint.clone(),
        project_dir: cfg.project_dir.clone(),
        coord: coord.clone(),
        x25519_private_key: x_priv,
        presence: presence.clone(),
    });
    let poll_handle = mailbox::spawn(MailboxLoopContext {
        coord: coord.clone(),
        responses,
        node_id: node_id.clone(),
        project_dir: cfg.project_dir.clone(),
        runtime_type: cfg.runtime.clone(),
        runtime_endpoint: cfg.runtime_endpoint.clone(),
        x25519_private_key: x_priv,
        presence,
        transport,
    });

    println!("Bridges daemon running. Press Ctrl+C to stop.");

    tokio::signal::ctrl_c()
        .await
        .map_err(|e| format!("signal: {}", e))?;

    println!("Shutting down daemon.");
    poll_handle.abort();
    api_handle.abort();
    recv_handle.abort();
    Ok(())
}

#[cfg(test)]
mod tests;
