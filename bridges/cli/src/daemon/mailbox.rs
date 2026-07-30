use super::*;

pub(super) struct MailboxLoopContext {
    pub(super) coord: CoordClient,
    pub(super) responses: Arc<Mutex<HashMap<String, local_api::PendingResponse>>>,
    pub(super) node_id: String,
    pub(super) project_dir: String,
    pub(super) runtime_type: String,
    pub(super) runtime_endpoint: String,
    pub(super) x25519_private_key: [u8; 32],
    pub(super) presence: Arc<Mutex<PresenceState>>,
    pub(super) transport: Arc<Transport>,
}

pub(super) fn spawn(context: MailboxLoopContext) -> tokio::task::JoinHandle<()> {
    let MailboxLoopContext {
        coord: poll_coord,
        responses: poll_responses,
        node_id: poll_node_id,
        project_dir: poll_project_dir,
        runtime_type: poll_runtime_type,
        runtime_endpoint: poll_runtime_endpoint,
        x25519_private_key: poll_x_priv,
        presence: poll_presence,
        transport: poll_transport,
    } = context;

    tokio::spawn(async move {
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
    })
}
