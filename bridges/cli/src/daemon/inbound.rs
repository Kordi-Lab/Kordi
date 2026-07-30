use super::*;

pub(super) struct InboundLoopContext {
    pub(super) transport: Arc<Transport>,
    pub(super) node_id: String,
    pub(super) responses: Arc<Mutex<HashMap<String, local_api::PendingResponse>>>,
    pub(super) runtime_type: String,
    pub(super) runtime_endpoint: String,
    pub(super) project_dir: String,
    pub(super) coord: CoordClient,
    pub(super) x25519_private_key: [u8; 32],
    pub(super) presence: Arc<Mutex<PresenceState>>,
}

pub(super) fn spawn(context: InboundLoopContext) -> tokio::task::JoinHandle<()> {
    let InboundLoopContext {
        transport: recv_transport,
        node_id: recv_node_id,
        responses: recv_responses,
        runtime_type: recv_runtime_type,
        runtime_endpoint: recv_runtime_endpoint,
        project_dir: recv_project_dir,
        coord: recv_coord,
        x25519_private_key: recv_x_priv,
        presence: recv_presence,
    } = context;

    tokio::spawn(async move {
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
    })
}
