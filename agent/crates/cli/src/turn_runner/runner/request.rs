//! Build the effective provider request after context and extension hooks.

use anyhow::Result;
use kordi_core::agent_session::messages_to_provider;
use kordi_core::types::AgentMessage;
use kordi_hooks::Event;
use kordi_monitor::RequestMutationFlags;
use kordi_provider::CompletionRequest;
use kordi_session::context;
use tokio::sync::mpsc;

use super::super::hooks::{request_mutation_flags, send_extension_event_safe};
use super::super::{TurnConfig, TurnEvent};

pub(super) async fn build_request(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    system_prompt: &str,
) -> Result<(CompletionRequest, RequestMutationFlags)> {
    let conn = config.conn.lock().await;
    let context = context::build_context(&conn, &config.session_id)?;
    drop(conn);

    let (messages, context_rewritten) =
        apply_context_hook(config, event_tx, context.messages).await?;
    let provider_messages = messages_to_provider(&messages);

    let mut mutation_flags = request_mutation_flags(context_rewritten);

    let tool_defs = super::super::tool_availability::available_definitions(
        config.tool_registry.tool_defs(),
        &config.tool_ctx,
    );

    let mut request = CompletionRequest {
        system_prompt: system_prompt.to_string(),
        messages: provider_messages,
        tools: tool_defs,
        extra_tool_schemas: vec![],
        model: config.model.id.clone(),
        max_tokens: Some(config.model.max_tokens as u32),
        stream: true,
        thinking: config.thinking.clone(),
    };

    if let Some(result) = send_extension_event_safe(
        &config.extensions,
        Event::BeforeProviderRequest {
            payload: serde_json::to_value(&request).unwrap_or_default(),
        },
        event_tx,
        "BeforeProviderRequest",
    )
    .await
        && let Some(payload) = result.payload
        && let Ok(updated_request) = serde_json::from_value::<CompletionRequest>(payload)
    {
        mutation_flags.request_rewritten = true;
        request = updated_request;
    }

    request.system_prompt = kordi_provider::with_active_model_context(
        &request.system_prompt,
        &request.model,
        &config.model.provider,
    );

    Ok((request, mutation_flags))
}

async fn apply_context_hook(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    mut messages: Vec<AgentMessage>,
) -> Result<(Vec<AgentMessage>, bool)> {
    let mut rewritten = false;
    if let Some(result) = send_extension_event_safe(
        &config.extensions,
        Event::Context(kordi_hooks::events::ContextEvent::new(messages.clone())),
        event_tx,
        "Context",
    )
    .await
        && let Some(replacement) = result.messages
    {
        rewritten = true;
        messages = replacement
            .into_iter()
            .filter_map(|message| serde_json::from_value::<AgentMessage>(message).ok())
            .collect();
    }

    Ok((messages, rewritten))
}
