use std::collections::{HashMap, HashSet};
use std::future::Future;
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
async fn dispatch_inbound_message(
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

async fn decode_mailbox_blob(
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

async fn encode_mailbox_blob(
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
async fn send_delivery_event(
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

async fn seed_transport_identities_from_projects<F, Fut>(
    transport: &Transport,
    my_node_id: &str,
    project_ids: &[String],
    mut fetch_keys: F,
) -> usize
where
    F: FnMut(&str) -> Fut,
    Fut: Future<Output = Result<Vec<PeerKeys>, String>>,
{
    let mut seeded = HashSet::new();
    for project_id in project_ids {
        let keys = match fetch_keys(project_id).await {
            Ok(keys) => keys,
            Err(err) => {
                eprintln!(
                    "  identity prewarm failed for project {}: {}",
                    project_id, err
                );
                continue;
            }
        };

        for key in keys {
            if key.node_id == my_node_id || seeded.contains(&key.node_id) {
                continue;
            }
            let decoded = match hex::decode(&key.x25519_pub) {
                Ok(decoded) if decoded.len() == 32 => decoded,
                Ok(decoded) => {
                    eprintln!(
                        "  identity prewarm skipped {}: invalid x25519 key length {}",
                        key.node_id,
                        decoded.len()
                    );
                    continue;
                }
                Err(err) => {
                    eprintln!(
                        "  identity prewarm skipped {}: bad x25519 key: {}",
                        key.node_id, err
                    );
                    continue;
                }
            };
            let mut x_pub = [0u8; 32];
            x_pub.copy_from_slice(&decoded);
            transport.remember_peer_identity(&key.node_id, x_pub).await;
            seeded.insert(key.node_id);
        }
    }

    seeded.len()
}

fn load_local_project_ids() -> Result<Vec<String>, String> {
    let conn = crate::db::open_db().map_err(|err| format!("open local db: {}", err))?;
    crate::db::init_db(&conn).map_err(|err| format!("init local db: {}", err))?;
    Ok(crate::queries::list_projects(&conn)
        .into_iter()
        .map(|project| project.project_id)
        .collect())
}

async fn sync_transport_identities_from_projects(
    transport: &Transport,
    coord: &CoordClient,
    my_node_id: &str,
) -> (usize, usize) {
    let project_ids = match load_local_project_ids() {
        Ok(project_ids) => project_ids,
        Err(err) => {
            eprintln!("  identity sync skipped: local db unavailable: {}", err);
            return (0, 0);
        }
    };

    if project_ids.is_empty() {
        let retain = std::collections::HashSet::new();
        let pruned = transport.retain_peer_identities(&retain).await;
        return (0, pruned);
    }

    let seeded = seed_transport_identities_from_projects(
        transport,
        my_node_id,
        &project_ids,
        |project_id| {
            let coord = coord.clone();
            let project_id = project_id.to_string();
            async move { coord.get_project_keys(&project_id).await }
        },
    )
    .await;

    let mut retain = HashSet::new();
    for project_id in &project_ids {
        match coord.get_project_keys(project_id).await {
            Ok(keys) => {
                for key in keys {
                    if key.node_id != my_node_id {
                        retain.insert(key.node_id);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "  identity prune skipped for project {}: {}",
                    project_id, err
                );
            }
        }
    }
    let pruned = transport.retain_peer_identities(&retain).await;
    (seeded, pruned)
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

    // Clone config values needed by both loops
    let project_dir_for_poll = cfg.project_dir.clone();
    let runtime_type = cfg.runtime.clone();
    let runtime_endpoint = cfg.runtime_endpoint.clone();

    // Inbound message loop
    let recv_transport = transport.clone();
    let recv_node_id = node_id.clone();
    let recv_responses = responses.clone();
    let recv_runtime_type = runtime_type.clone();
    let recv_runtime_endpoint = runtime_endpoint.clone();
    let recv_project_dir = cfg.project_dir.clone();
    let recv_coord = coord.clone();
    let recv_x_priv = x_priv;
    let recv_presence = presence.clone();
    let recv_handle = tokio::spawn(async move {
        loop {
            match recv_transport.recv().await {
                Ok((source, plaintext)) => {
                    let peer_id = source.node_id().to_string();
                    let msg: serde_json::Value = match serde_json::from_slice(&plaintext) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("invalid message from {}: {}", peer_id, e);
                            continue;
                        }
                    };

                    let from = msg["from"].as_str().unwrap_or(&peer_id);
                    let project_id = msg["projectId"].as_str().unwrap_or("");
                    let kind = msg["messageType"].as_str().unwrap_or("ask");
                    let request_id = msg["requestId"].as_str().unwrap_or("");
                    let session_id = msg["sessionId"].as_str();
                    let payload = &msg["payload"];

                    // Shared-workspace sync is handled out of band, not through relay messages.
                    if kind == "sync" {
                        println!(
                            "  sync message from {} (handled out of band, skipping)",
                            from
                        );
                        continue;
                    }

                    // Handle delivery events — update staged local outcomes for the CLI.
                    if kind == "delivery_event" {
                        let stage = payload["stage"].as_str().unwrap_or("");
                        let error = payload["error"].as_str();
                        if !request_id.is_empty() {
                            local_api::store_delivery_event(
                                &recv_responses,
                                request_id,
                                from,
                                stage,
                                error,
                            )
                            .await;
                            println!(
                                "  delivery event from {} for {} → {}",
                                from, request_id, stage
                            );
                        }
                        continue;
                    }

                    // Handle response messages — store them for the CLI to poll
                    if kind == "response" {
                        let response_text = payload["message"].as_str().unwrap_or("");
                        if !request_id.is_empty() {
                            local_api::store_response(
                                &recv_responses,
                                request_id,
                                from,
                                response_text,
                            )
                            .await;
                            println!(
                                "  response from {} for {} ({} chars)",
                                from,
                                request_id,
                                response_text.len()
                            );
                        } else {
                            println!(
                                "  response from {} (no request_id, {} chars)",
                                from,
                                response_text.len()
                            );
                        }
                        continue;
                    }

                    send_delivery_event(
                        recv_transport.as_ref(),
                        &recv_coord,
                        &recv_node_id,
                        &recv_x_priv,
                        from,
                        project_id,
                        request_id,
                        "received_by_peer_daemon",
                        None,
                    )
                    .await;

                    match dispatch_inbound_message(
                        &recv_coord,
                        &recv_runtime_type,
                        &recv_runtime_endpoint,
                        &recv_project_dir,
                        from,
                        project_id,
                        kind,
                        session_id,
                        payload,
                    )
                    .await
                    {
                        Ok(response) => {
                            recv_presence
                                .lock()
                                .await
                                .note_runtime_ok(format!("handled {} from {}", kind, from));
                            println!(
                                "  {} from {} → responded ({} chars)",
                                kind,
                                from,
                                response.len()
                            );
                            // Send encrypted response back, include requestId so sender can match it
                            let reply = serde_json::json!({
                                "from": recv_node_id,
                                "projectId": project_id,
                                "messageType": "response",
                                "requestId": request_id,
                                "payload": { "message": response },
                            });
                            let reply_bytes = serde_json::to_vec(&reply).unwrap_or_default();
                            if let Err(e) = recv_transport.send(from, &reply_bytes).await {
                                eprintln!("  failed to send reply to {}: {}", from, e);
                                match encode_mailbox_blob(
                                    &recv_coord,
                                    &recv_node_id,
                                    &recv_x_priv,
                                    from,
                                    Some(project_id),
                                    &reply_bytes,
                                )
                                .await
                                {
                                    Ok(reply_blob) => {
                                        if let Err(relay_err) = recv_coord
                                            .relay_message(from, &reply_blob, Some(project_id))
                                            .await
                                        {
                                            eprintln!(
                                                "  failed to relay reply to {}: {}",
                                                from, relay_err
                                            );
                                        }
                                    }
                                    Err(encode_err) => eprintln!(
                                        "  failed to encrypt relay reply to {}: {}",
                                        from, encode_err
                                    ),
                                }
                            }
                        }
                        Err(e) => {
                            recv_presence.lock().await.note_runtime_error(format!(
                                "dispatch error for {} from {}: {}",
                                kind, from, e
                            ));
                            send_delivery_event(
                                recv_transport.as_ref(),
                                &recv_coord,
                                &recv_node_id,
                                &recv_x_priv,
                                from,
                                project_id,
                                request_id,
                                "processing_failed",
                                Some(&e),
                            )
                            .await;
                            eprintln!("  dispatch error for {} from {}: {}", kind, from, e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("recv error: {}", e);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    });

    // Mailbox polling loop — fetch messages from coordination server every 5s
    let poll_coord = coord.clone();
    let poll_responses = responses.clone();
    let poll_node_id = node_id.clone();
    let poll_project_dir = project_dir_for_poll;
    let poll_runtime_type = runtime_type.clone();
    let poll_runtime_endpoint = runtime_endpoint.clone();
    let poll_x_priv = x_priv;
    let poll_presence = presence.clone();
    let poll_transport = transport.clone();
    let poll_handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let (_seeded, pruned) = sync_transport_identities_from_projects(
                poll_transport.as_ref(),
                &poll_coord,
                &poll_node_id,
            )
            .await;
            if pruned > 0 {
                poll_presence.lock().await.note_coord_ok(format!(
                    "pruned {} stale transport peer identities after coordination refresh",
                    pruned
                ));
            }
            let messages = match poll_coord.fetch_mailbox().await {
                Ok(m) => {
                    let detail = if m.is_empty() {
                        "mailbox poll succeeded (empty)".to_string()
                    } else {
                        format!("mailbox poll succeeded ({} messages)", m.len())
                    };
                    poll_presence.lock().await.note_coord_ok(detail);
                    if m.is_empty() {
                        continue;
                    }
                    m
                }
                Err(e) => {
                    poll_presence
                        .lock()
                        .await
                        .note_coord_error(format!("mailbox poll failed: {}", e));
                    continue;
                }
            };

            println!("  mailbox: {} pending messages", messages.len());
            for msg in &messages {
                let from = msg["from"].as_str().unwrap_or("");
                let blob = msg["blob"].as_str().unwrap_or("");
                let mailbox_project_id = msg["projectId"].as_str();
                if blob.is_empty() {
                    continue;
                }

                let plaintext = match decode_mailbox_blob(
                    &poll_coord,
                    &poll_node_id,
                    &poll_x_priv,
                    from,
                    mailbox_project_id,
                    blob,
                )
                .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("  mailbox decode failed from {}: {}", from, e);
                        continue;
                    }
                };

                let parsed: serde_json::Value = match serde_json::from_slice(&plaintext) {
                    Ok(v) => v,
                    Err(_) => {
                        eprintln!("  mailbox: bad json from {}", from);
                        continue;
                    }
                };

                let msg_from = parsed["from"].as_str().unwrap_or(from);
                let _project_id = parsed["projectId"].as_str().unwrap_or("");
                let kind = parsed["messageType"].as_str().unwrap_or("ask");
                let request_id = parsed["requestId"].as_str().unwrap_or("");
                let session_id = parsed["sessionId"].as_str();
                let payload = &parsed["payload"];

                // Shared-workspace sync is handled out of band, not through mailbox.
                if kind == "sync" {
                    continue;
                }

                // Handle delivery events.
                if kind == "delivery_event" {
                    let stage = payload["stage"].as_str().unwrap_or("");
                    let error = payload["error"].as_str();
                    if !request_id.is_empty() {
                        local_api::store_delivery_event(
                            &poll_responses,
                            request_id,
                            msg_from,
                            stage,
                            error,
                        )
                        .await;
                        println!(
                            "  mailbox delivery event from {} for {} → {}",
                            msg_from, request_id, stage
                        );
                    }
                    continue;
                }

                // Handle response
                if kind == "response" {
                    let response_text = payload["message"].as_str().unwrap_or("");
                    if !request_id.is_empty() {
                        local_api::store_response(
                            &poll_responses,
                            request_id,
                            msg_from,
                            response_text,
                        )
                        .await;
                        println!(
                            "  mailbox response from {} ({} chars)",
                            msg_from,
                            response_text.len()
                        );
                    }
                    continue;
                }

                send_delivery_event(
                    poll_transport.as_ref(),
                    &poll_coord,
                    &poll_node_id,
                    &poll_x_priv,
                    msg_from,
                    _project_id,
                    request_id,
                    "received_by_peer_daemon",
                    None,
                )
                .await;

                match dispatch_inbound_message(
                    &poll_coord,
                    &poll_runtime_type,
                    &poll_runtime_endpoint,
                    &poll_project_dir,
                    msg_from,
                    _project_id,
                    kind,
                    session_id,
                    payload,
                )
                .await
                {
                    Ok(response) => {
                        poll_presence
                            .lock()
                            .await
                            .note_runtime_ok(format!("handled mailbox {} from {}", kind, msg_from));
                        println!(
                            "  mailbox {} from {} → responded ({} chars)",
                            kind,
                            msg_from,
                            response.len()
                        );
                        // Send response back via relay
                        let reply = serde_json::json!({
                            "from": poll_node_id,
                            "messageType": "response",
                            "requestId": request_id,
                            "payload": { "message": response },
                        });
                        match encode_mailbox_blob(
                            &poll_coord,
                            &poll_node_id,
                            &poll_x_priv,
                            msg_from,
                            Some(_project_id),
                            &serde_json::to_vec(&reply).unwrap_or_default(),
                        )
                        .await
                        {
                            Ok(reply_blob) => {
                                if let Err(e) = poll_coord
                                    .relay_message(msg_from, &reply_blob, Some(_project_id))
                                    .await
                                {
                                    eprintln!("  failed to relay response to {}: {}", msg_from, e);
                                }
                            }
                            Err(e) => eprintln!(
                                "  failed to encrypt relay response to {}: {}",
                                msg_from, e
                            ),
                        }
                    }
                    Err(e) => {
                        poll_presence.lock().await.note_runtime_error(format!(
                            "mailbox dispatch error for {} from {}: {}",
                            kind, msg_from, e
                        ));
                        send_delivery_event(
                            poll_transport.as_ref(),
                            &poll_coord,
                            &poll_node_id,
                            &poll_x_priv,
                            msg_from,
                            _project_id,
                            request_id,
                            "processing_failed",
                            Some(&e),
                        )
                        .await;
                        eprintln!(
                            "  mailbox dispatch error for {} from {}: {}",
                            kind, msg_from, e
                        )
                    }
                }
            }
        }
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
mod tests {
    use super::*;
    use crate::coord_client::PeerKeys;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn test_transport(node_id: &str) -> Transport {
        let signing = SigningKey::generate(&mut OsRng);
        let x_priv = crate::crypto::ed25519_to_x25519_private(&signing.to_bytes());
        Transport::new_for_tests(ConnManager::new(None), None, node_id.to_string(), x_priv)
    }

    #[tokio::test]
    async fn sync_transport_identities_prunes_stale_peers() {
        let transport = test_transport("kd_self");
        transport
            .remember_peer_identity("kd_peer_old", [7u8; 32])
            .await;
        transport
            .remember_peer_identity("kd_peer_new", [8u8; 32])
            .await;

        let retain = std::collections::HashSet::from(["kd_peer_new".to_string()]);
        let pruned = transport.retain_peer_identities(&retain).await;

        assert_eq!(pruned, 1);
        let conn = transport.conn.lock().await;
        assert!(conn.expected_peer_key("kd_peer_old").is_none());
        assert_eq!(conn.expected_peer_key("kd_peer_new"), Some([8u8; 32]));
    }

    #[tokio::test]
    async fn seed_transport_identities_from_projects_primes_first_contact_cache() {
        let transport = test_transport("kd_self");
        let peer_signing = SigningKey::generate(&mut OsRng);
        let peer_x25519 =
            crate::crypto::ed25519_to_x25519_public(peer_signing.verifying_key().as_bytes())
                .unwrap();
        let project_ids = vec!["proj_1".to_string()];

        let seeded = seed_transport_identities_from_projects(
            &transport,
            "kd_self",
            &project_ids,
            |_project_id| async {
                Ok(vec![PeerKeys {
                    node_id: "kd_peer".to_string(),
                    ed25519_pub: "unused".to_string(),
                    x25519_pub: hex::encode(peer_x25519),
                }])
            },
        )
        .await;

        assert_eq!(seeded, 1);
        let conn = transport.conn.lock().await;
        assert_eq!(
            conn.resolve_peer_id(&crate::crypto::node_id_wire_id("kd_peer")),
            Some("kd_peer".to_string())
        );
        assert_eq!(conn.expected_peer_key("kd_peer"), Some(peer_x25519));
    }
}
