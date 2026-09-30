use super::*;

pub(super) const RAW_OMP_MESSAGE: &str = "omp_message";

pub(super) type PreparedHistory = (
    Vec<serde_json::Value>,
    Vec<Option<String>>,
    String,
    Vec<ImageInput>,
    Vec<serde_json::Value>,
);

pub(super) fn route_scope(config: &TurnConfig) -> Result<String> {
    let api = serde_json::to_value(&config.model.api)?;
    route_scope_for(
        &config.model.provider,
        &config.model.id,
        api,
        &config.base_url,
        config
            .auth
            .as_ref()
            .and_then(|auth| auth.account_id.as_deref()),
        config
            .auth
            .as_ref()
            .map(|auth| auth.credential.as_str())
            .unwrap_or(&config.api_key),
    )
}

pub(super) fn route_scope_for(
    provider: &str,
    model: &str,
    api: serde_json::Value,
    base_url: &str,
    account_id: Option<&str>,
    credential: &str,
) -> Result<String> {
    let auth_identity = account_id
        .filter(|id| !id.is_empty())
        .map(|id| format!("account:{id}"))
        .unwrap_or_else(|| format!("credential:{:x}", Sha256::digest(credential.as_bytes())));
    let scope_input = serde_json::json!([provider, model, api, base_url, auth_identity]);
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&scope_input)?)
    ))
}

pub(crate) fn prepare_history(
    conn: &rusqlite::Connection,
    session_id: &str,
    route_scope: &str,
) -> Result<PreparedHistory> {
    let path = tree::active_path(conn, session_id)?;
    let context = context::build_context_from_path(&path)?;
    let entries = path
        .iter()
        .map(store::parse_entry)
        .collect::<Result<Vec<_>>>()?;
    let mut raw_by_id = std::collections::HashMap::new();
    for entry in &entries {
        if let SessionEntry::Custom {
            custom_type,
            data: Some(data),
            ..
        } = entry
            && custom_type == RAW_OMP_MESSAGE
            && data.get("routeScope").and_then(|value| value.as_str()) == Some(route_scope)
            && let (Some(id), Some(raw)) = (
                data.get("entryId").and_then(|value| value.as_str()),
                data.get("message"),
            )
        {
            raw_by_id.insert(id.to_string(), raw.clone());
        }
    }
    let mut cursor = 0usize;
    let mut aligned = Vec::with_capacity(context.messages.len());
    for message in &context.messages {
        let exact = entries.iter().enumerate().skip(cursor).find(|(_, entry)| {
            entry_as_message(entry).is_some_and(|stored| {
                serde_json::to_value(stored).ok() == serde_json::to_value(message).ok()
            })
        });
        let candidate = exact.or_else(|| {
            let mut matches = entries
                .iter()
                .enumerate()
                .skip(cursor)
                .filter(|(_, entry)| {
                    entry_as_message(entry).is_some_and(|stored| {
                        message_identity(&stored) == message_identity(message)
                    })
                });
            let first = matches.next();
            if matches.next().is_none() {
                first
            } else {
                None
            }
        });
        if let Some((index, entry)) = candidate {
            cursor = index + 1;
            aligned.push(Some(entry.base().id.as_str().to_string()));
        } else {
            aligned.push(None);
        }
    }
    let prompt_index = context
        .messages
        .iter()
        .rposition(|message| matches!(message, AgentMessage::User(_)))
        .ok_or_else(|| anyhow!("OMP turn has no persisted user request"))?;
    let prompt_entry_id = aligned[prompt_index]
        .clone()
        .ok_or_else(|| anyhow!("OMP request entry ID could not be aligned"))?;
    let prompt_images = match &context.messages[prompt_index] {
        AgentMessage::User(user) => user
            .content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Image { data, mime_type } => Some(ImageInput {
                    kind: "image".into(),
                    data: data.clone(),
                    mime_type: mime_type.clone(),
                }),
                _ => None,
            })
            .collect(),
        _ => unreachable!(),
    };
    let mut messages = Vec::with_capacity(prompt_index);
    let mut ids = Vec::with_capacity(prompt_index);
    for (message, id) in context.messages[..prompt_index]
        .iter()
        .zip(&aligned[..prompt_index])
    {
        let value = id
            .as_ref()
            .and_then(|id| raw_by_id.get(id))
            .cloned()
            .unwrap_or(serde_json::to_value(message)?);
        messages.push(value);
        ids.push(id.clone());
    }
    let trailing = context.messages[prompt_index + 1..]
        .iter()
        .map(|message| {
            if !matches!(message, AgentMessage::Custom(_)) {
                bail!(
                    "OMP prompt has an unexpected trailing {} context message",
                    message_identity(message).0
                );
            }
            Ok(serde_json::to_value(message)?)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((messages, ids, prompt_entry_id, prompt_images, trailing))
}

fn entry_as_message(entry: &SessionEntry) -> Option<AgentMessage> {
    match entry {
        SessionEntry::Message { message, .. } => Some(message.clone()),
        SessionEntry::CustomMessage {
            base,
            custom_type,
            content,
            display,
            details,
        } => Some(AgentMessage::Custom(CustomMessage {
            custom_type: custom_type.clone(),
            content: content.clone(),
            display: *display,
            details: details.clone(),
            timestamp: base.timestamp.timestamp_millis(),
        })),
        SessionEntry::BranchSummary {
            base,
            summary,
            from_id,
            ..
        } => Some(AgentMessage::BranchSummary(BranchSummaryMessage {
            summary: summary.clone(),
            from_id: from_id.as_str().into(),
            timestamp: base.timestamp.timestamp_millis(),
        })),
        SessionEntry::Compaction {
            base,
            summary,
            tokens_before,
            ..
        } => Some(AgentMessage::CompactionSummary(CompactionSummaryMessage {
            summary: summary.clone(),
            tokens_before: *tokens_before,
            timestamp: base.timestamp.timestamp_millis(),
        })),
        _ => None,
    }
}

fn message_identity(message: &AgentMessage) -> (&'static str, i64) {
    match message {
        AgentMessage::User(value) => ("user", value.timestamp),
        AgentMessage::Assistant(value) => ("assistant", value.timestamp),
        AgentMessage::ToolResult(value) => ("toolResult", value.timestamp),
        AgentMessage::BashExecution(value) => ("bashExecution", value.timestamp),
        AgentMessage::Custom(value) => ("custom", value.timestamp),
        AgentMessage::BranchSummary(value) => ("branchSummary", value.timestamp),
        AgentMessage::CompactionSummary(value) => ("compactionSummary", value.timestamp),
    }
}

pub(super) fn build_request(
    config: &TurnConfig,
    prompt_text: String,
    history: PreparedHistory,
    system_prompt: String,
    capabilities: Capabilities,
) -> Result<RunRequest> {
    let (messages, message_entry_ids, prompt_entry_id, prompt_images, trailing_messages) = history;
    let (kind, credential) = match &config.auth {
        Some(auth) => (
            match auth.method {
                ProviderAuthMethod::OAuth => AuthKind::Oauth,
                ProviderAuthMethod::ApiKey => AuthKind::ApiKey,
            },
            Some(auth.credential.clone()),
        ),
        None if !config.api_key.trim().is_empty() => {
            (AuthKind::ApiKey, Some(config.api_key.clone()))
        }
        None if crate::login::provider_allows_no_auth(
            &config.model.provider,
            Some(&config.base_url),
        ) =>
        {
            (AuthKind::None, None)
        }
        None => bail!("Selected provider has no resolved credential"),
    };
    let api = serde_json::to_value(&config.model.api)?
        .as_str()
        .map(str::to_owned);
    let (provider, api, base_url, headers) = resolve_omp_transport(
        &config.model.provider,
        api,
        &config.base_url,
        &config.headers,
        config.auth.as_ref().map(|auth| auth.method),
        config
            .auth
            .as_ref()
            .map(|auth| auth.credential_provider.as_str()),
        config
            .auth
            .as_ref()
            .and_then(|auth| auth.account_id.as_deref()),
    )?;
    let tools = config
        .tool_registry
        .tool_defs()
        .iter()
        .map(|definition| {
            let function = definition
                .get("function")
                .context("tool definition has no function")?;
            Ok(ToolDefinition {
                name: function
                    .get("name")
                    .and_then(|value| value.as_str())
                    .context("tool has no name")?
                    .to_string(),
                description: function
                    .get("description")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                input_schema: function
                    .get("parameters")
                    .cloned()
                    .context("tool has no parameters")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let route_id = uuid::Uuid::new_v4().to_string();
    Ok(RunRequest {
        run_id: route_id.clone(),
        request_id: prompt_entry_id.clone(),
        attempt_id: route_id,
        session_id: config.session_id.clone(),
        model: ModelConfig {
            provider,
            id: config.model.id.clone(),
            api,
            base_url,
            context_window: u32::try_from(config.model.context_window).ok(),
            max_tokens: u32::try_from(config.model.max_tokens).ok(),
        },
        auth: AuthConfig {
            kind,
            credential,
            headers: Some(headers),
        },
        thinking: config.thinking.clone(),
        system_prompt,
        messages,
        message_entry_ids: Some(message_entry_ids),
        prompt: Prompt {
            text: prompt_text,
            entry_id: Some(prompt_entry_id),
            images: prompt_images,
            trailing_messages,
        },
        cwd: config.tool_ctx.cwd.display().to_string(),
        tools,
        hooks: if config.extensions.has_hook_host() {
            vec!["context".into(), "before_provider_request".into()]
        } else {
            vec![]
        },
        limits: RunLimits::default(),
        compaction: Some(CompactionSettings {
            enabled: config.compaction_settings.enabled,
            reserve_tokens: u32::try_from(config.compaction_settings.reserve_tokens)
                .unwrap_or(u32::MAX),
            keep_recent_tokens: u32::try_from(config.compaction_settings.keep_recent_tokens)
                .unwrap_or(u32::MAX),
            threshold_tokens: None,
        }),
        capabilities,
    })
}

type OmpTransport = (
    String,
    Option<String>,
    Option<String>,
    BTreeMap<String, String>,
);

pub(super) fn resolve_omp_transport(
    provider: &str,
    api: Option<String>,
    base_url: &str,
    headers: &std::collections::HashMap<String, String>,
    auth_method: Option<ProviderAuthMethod>,
    credential_provider: Option<&str>,
    account_id: Option<&str>,
) -> Result<OmpTransport> {
    let mut headers = headers
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();
    let codex_oauth = matches!(auth_method, Some(ProviderAuthMethod::OAuth))
        && credential_provider == Some("openai-codex")
        && matches!(provider, "openai" | "openai-codex");
    if codex_oauth {
        let account_id = account_id
            .filter(|id| !id.trim().is_empty())
            .context("Selected ChatGPT account has no account ID")?;
        headers.retain(|key, _| !key.eq_ignore_ascii_case("chatgpt-account-id"));
        headers.insert("chatgpt-account-id".into(), account_id.into());
        let base_url = if base_url.trim().is_empty() || base_url.contains("api.openai.com") {
            "https://chatgpt.com/backend-api".to_string()
        } else {
            base_url.trim_end_matches('/').to_string()
        };
        return Ok((
            "openai-codex".into(),
            Some("openai-codex-responses".into()),
            Some(base_url),
            headers,
        ));
    }
    Ok((
        provider.into(),
        api,
        Some(base_url.to_owned()).filter(|url| !url.is_empty()),
        headers,
    ))
}

pub(super) async fn persist_result(
    conn: &std::sync::Arc<tokio::sync::Mutex<rusqlite::Connection>>,
    session_id: &str,
    route_scope: &str,
    request: &RunRequest,
    result: &kordi_omp_runtime::RunResult,
) -> Result<()> {
    let parsed = result
        .messages
        .iter()
        .map(|raw| {
            let message: AgentMessage = serde_json::from_value(raw.clone())
                .context("OMP returned an invalid Kordi message")?;
            if matches!(message, AgentMessage::User(_)) {
                bail!("OMP returned a duplicate user request");
            }
            Ok(message)
        })
        .collect::<Result<Vec<_>>>()?;
    let new_ids = parsed
        .iter()
        .map(|_| EntryId::generate())
        .collect::<Vec<_>>();
    let kept_id = result
        .checkpoint
        .as_ref()
        .map(|checkpoint| {
            checkpoint
                .first_kept_entry_id
                .clone()
                .or_else(|| {
                    let index = checkpoint.first_kept_message_index;
                    if index < request.messages.len() {
                        request.message_entry_ids.as_ref()?.get(index)?.clone()
                    } else if index == request.messages.len() {
                        request.prompt.entry_id.clone()
                    } else {
                        new_ids
                            .get(index - request.messages.len() - 1)
                            .map(|id| id.as_str().to_string())
                    }
                })
                .ok_or_else(|| anyhow!("OMP compaction boundary lacks a stable Kordi entry ID"))
        })
        .transpose()?;
    let mut conn = conn.lock().await;
    if let Some(kept_id) = kept_id.as_deref()
        && !new_ids.iter().any(|id| id.as_str() == kept_id)
        && store::get_entry(&conn, session_id, kept_id)?.is_none()
    {
        bail!("OMP compaction boundary does not exist in this session");
    }
    let tx = conn.transaction()?;
    let mut parent_id = get_leaf_raw(&tx, session_id);
    for ((raw, message), id) in result.messages.iter().zip(parsed).zip(new_ids) {
        let base = EntryBase {
            id: id.clone(),
            parent_id,
            timestamp: Utc::now(),
        };
        store::append_entry(&tx, session_id, &SessionEntry::Message { base, message })?;
        let sidecar = SessionEntry::Custom {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: Some(id.clone()),
                timestamp: Utc::now(),
            },
            custom_type: RAW_OMP_MESSAGE.to_string(),
            data: Some(
                serde_json::json!({ "entryId": id.as_str(), "routeScope": route_scope, "message": raw }),
            ),
        };
        parent_id = Some(sidecar.base().id.clone());
        store::append_entry(&tx, session_id, &sidecar)?;
    }
    if let (Some(checkpoint), Some(kept_id)) = (&result.checkpoint, kept_id) {
        let compaction = SessionEntry::Compaction {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id,
                timestamp: Utc::now(),
            },
            summary: checkpoint.summary.clone(),
            first_kept_entry_id: EntryId(kept_id),
            tokens_before: checkpoint.tokens_before,
            details: None,
            from_plugin: false,
        };
        store::append_entry(&tx, session_id, &compaction)?;
    }
    tx.commit()?;
    Ok(())
}
