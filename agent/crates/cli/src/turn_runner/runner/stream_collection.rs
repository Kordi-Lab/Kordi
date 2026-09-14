use super::*;

pub(super) async fn collect_stream_events(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    request: CompletionRequest,
) -> Result<StreamCollection> {
    if config.api_key.trim().is_empty()
        && provider_requires_credentials(&config.model.provider, &config.base_url)
    {
        let message = missing_credentials_message(&config.model.provider);
        let _ = event_tx.send(TurnEvent::Error(message.clone()));
        return Err(anyhow::anyhow!(message));
    }

    let local_lock = match acquire_local_inference_lock(config) {
        Ok(lock) => lock,
        Err(err) => {
            let message = err.to_string();
            let _ = event_tx.send(TurnEvent::Error(message.clone()));
            return Err(anyhow::anyhow!(message));
        }
    };
    let local_timeout = local_lock.as_ref().map(|_| local_model_overload_timeout());

    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
    let provider = config.provider.clone();
    let stream_cancel = config.cancel.clone();
    let options = build_request_options(config, event_tx.clone());

    let stream_handle = tokio::spawn(async move {
        let result = catch_contained_panics(provider.stream(request, options, stream_tx)).await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                if !stream_cancel.is_cancelled() {
                    Err(error)
                } else {
                    Ok(())
                }
            }
            Err(message) => {
                if !stream_cancel.is_cancelled() {
                    Err(kordi_core::error::KordiError::Provider(format!(
                        "provider stream panicked: {message}"
                    )))
                } else {
                    Ok(())
                }
            }
        }
    });

    let mut events = Vec::new();
    let mut argument_progress =
        super::super::tool_argument_progress::ToolArgumentProgress::default();
    let mut context_overflow_error = None;
    let mut first_stream_event_at_ms = None;
    let mut first_text_delta_at_ms = None;

    let drain_ready_events =
        |stream_rx: &mut mpsc::UnboundedReceiver<StreamEvent>,
         events: &mut Vec<StreamEvent>,
         context_overflow_error: &mut Option<String>,
         first_stream_event_at_ms: &mut Option<i64>,
         first_text_delta_at_ms: &mut Option<i64>| {
            while let Ok(event) = stream_rx.try_recv() {
                forward_stream_event(
                    event_tx,
                    &event,
                    context_overflow_error,
                    first_stream_event_at_ms,
                    first_text_delta_at_ms,
                );
                events.push(event);
            }
        };

    let mut cancelled = false;
    loop {
        tokio::select! {
            _ = wait_for_optional_timeout(local_timeout) => {
                let timeout = local_timeout.expect("local timeout is set for optional wait");
                let message = local_model_overload_message(config, timeout);
                stream_handle.abort();
                let _ = event_tx.send(TurnEvent::Error(message.clone()));
                return Err(anyhow::anyhow!(message));
            }
            _ = config.cancel.cancelled() => {
                cancelled = true;
                drain_ready_events(
                    &mut stream_rx,
                    &mut events,
                    &mut context_overflow_error,
                    &mut first_stream_event_at_ms,
                    &mut first_text_delta_at_ms,
                );
                stream_handle.abort();
                break;
            }
            maybe_event = stream_rx.recv() => {
                let Some(event) = maybe_event else { break; };
                if argument_progress.observe(&event).is_err() {
                    stream_handle.abort();
                    let message = "The model kept generating empty tool arguments. The request was stopped; please retry.";
                    let _ = event_tx.send(TurnEvent::Error(message.to_string()));
                    return Err(anyhow::anyhow!(message));
                }
                forward_stream_event(
                    event_tx,
                    &event,
                    &mut context_overflow_error,
                    &mut first_stream_event_at_ms,
                    &mut first_text_delta_at_ms,
                );
                events.push(event);

                if config.cancel.is_cancelled() {
                    cancelled = true;
                    drain_ready_events(
                        &mut stream_rx,
                        &mut events,
                        &mut context_overflow_error,
                        &mut first_stream_event_at_ms,
                        &mut first_text_delta_at_ms,
                    );
                    stream_handle.abort();
                    break;
                }
            }
        }
    }

    match stream_handle.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            if !config.cancel.is_cancelled() {
                let message = error.to_string();
                let _ = event_tx.send(TurnEvent::Error(message.clone()));
                return Err(anyhow::anyhow!(message));
            }
        }
        Err(error) => {
            if !config.cancel.is_cancelled() && !error.is_cancelled() {
                let message = format!("stream task failed: {error}");
                let _ = event_tx.send(TurnEvent::Error(message.clone()));
                return Err(anyhow::anyhow!(message));
            }
        }
    }

    Ok(StreamCollection {
        events,
        context_overflow_error,
        first_stream_event_at_ms,
        first_text_delta_at_ms,
        cancelled,
    })
}
