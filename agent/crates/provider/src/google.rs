mod convert;
mod events;
#[cfg(test)]
mod tests;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::error::{
    ProviderError, ProviderErrorFormat, google_retry_delay_ms,
    unexpected_response_with_sensitive_values,
};
use crate::{CompletionRequest, Provider, RequestOptions, StreamEvent, retry::with_retry};

pub use convert::{
    convert_messages_google, convert_tools_google, convert_tools_google_with_hosted_search,
};
use events::process_google_event;

/// Google Generative AI (Gemini) provider.
pub struct GoogleProvider {
    client: Client,
}

impl Default for GoogleProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl GoogleProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(300))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }
}

#[async_trait]
impl Provider for GoogleProvider {
    fn name(&self) -> &str {
        "google"
    }

    async fn complete(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.stream(request, options, tx).await?;

        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        Ok(events)
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?key={}&alt=sse",
            options.base_url.trim_end_matches('/'),
            request.model,
            options.api_key,
        );

        let contents = convert_messages_google(&request.messages);
        let tools = convert_tools_google_with_hosted_search(&request.tools);

        let mut body = json!({
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": request.max_tokens.unwrap_or(16384),
            }
        });

        if !request.system_prompt.is_empty() {
            body["systemInstruction"] = json!({
                "parts": [{ "text": request.system_prompt }]
            });
        }

        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }
        let provider_name = options.provider.clone();
        let sensitive_values = options.sensitive_values();

        let response = with_retry(
            options.max_retries,
            options.retry_base_delay_ms,
            options.max_retry_delay_ms,
            options.cancel.clone(),
            options.retry_callback.clone(),
            || {
                let mut req = self
                    .client
                    .post(&url)
                    .header("content-type", "application/json");

                for (k, v) in &options.headers {
                    req = req.header(k.as_str(), v.as_str());
                }
                let body_clone = body.clone();
                let request_url = url.clone();
                let provider_name = provider_name.clone();
                let sensitive_values = sensitive_values.clone();
                async move {
                    let response = req.json(&body_clone).send().await.map_err(|error| {
                        ProviderError::from_reqwest(
                            &provider_name,
                            "streamGenerateContent",
                            &request_url,
                            &error,
                        )
                    })?;

                    if !response.status().is_success() {
                        return Err(unexpected_response_with_sensitive_values(
                            &provider_name,
                            "streamGenerateContent",
                            ProviderErrorFormat::Google,
                            response,
                            &sensitive_values,
                        )
                        .await);
                    }
                    Ok(response)
                }
            },
        )
        .await
        .map_err(KordiError::from)?;

        use futures::StreamExt;
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();

        loop {
            let chunk_result = tokio::select! {
                _ = options.cancel.cancelled() => {
                    let _ = tx.send(StreamEvent::Done);
                    return Ok(());
                }
                chunk_result = stream.next() => chunk_result,
            };
            let Some(chunk_result) = chunk_result else {
                break;
            };

            let chunk = match chunk_result {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = tx.send(StreamEvent::Error {
                        error: ProviderError::from_reqwest(
                            &options.provider,
                            "streamGenerateContent stream",
                            &url,
                            &error,
                        ),
                    });
                    let _ = tx.send(StreamEvent::Done);
                    return Ok(());
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find("\n\n") {
                let block = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();

                for line in block.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" {
                            let _ = tx.send(StreamEvent::Done);
                            return Ok(());
                        }
                        if let Ok(event) = serde_json::from_str::<Value>(data) {
                            if let Some(error) = event.get("error") {
                                let message = error.get("message").and_then(|value| value.as_str());
                                let code = error
                                    .get("status")
                                    .or_else(|| error.get("code"))
                                    .and_then(|value| match value {
                                        Value::String(value) => Some(value.clone()),
                                        Value::Number(value) => Some(value.to_string()),
                                        _ => None,
                                    });
                                let error = ProviderError::stream_with_sensitive_values(
                                    &options.provider,
                                    "streamGenerateContent stream",
                                    message,
                                    code.as_deref(),
                                    &sensitive_values,
                                )
                                .with_retry_after_ms(google_retry_delay_ms(&event));
                                let _ = tx.send(StreamEvent::Error { error });
                                let _ = tx.send(StreamEvent::Done);
                                return Ok(());
                            }
                            process_google_event(&event, &tx);
                        }
                    }
                }
            }
        }

        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}
