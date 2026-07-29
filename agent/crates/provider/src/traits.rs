use async_trait::async_trait;
use kordi_core::error::KordiResult;
use tokio::sync::mpsc;

use crate::types::{CompletionRequest, RequestOptions, StreamEvent};

/// Provider trait — implemented by each API backend.
/// Returns events via channel for real-time streaming.
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;

    /// Non-streaming: returns all events at once.
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

    /// Streaming: sends events to channel as they arrive.
    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()>;
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use kordi_core::error::KordiError;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::types::ProviderAuthMode;

    struct StreamingProvider {
        fail: bool,
    }

    #[async_trait]
    impl Provider for StreamingProvider {
        fn name(&self) -> &str {
            "streaming-test"
        }

        async fn stream(
            &self,
            _request: CompletionRequest,
            _options: RequestOptions,
            tx: mpsc::UnboundedSender<StreamEvent>,
        ) -> KordiResult<()> {
            let _ = tx.send(StreamEvent::TextDelta {
                text: "first".to_string(),
            });

            if self.fail {
                return Err(KordiError::Provider("stream failed".to_string()));
            }

            tokio::spawn(async move {
                tokio::task::yield_now().await;
                let _ = tx.send(StreamEvent::TextDelta {
                    text: "second".to_string(),
                });
                let _ = tx.send(StreamEvent::Done);
            });
            Ok(())
        }
    }

    fn request() -> CompletionRequest {
        CompletionRequest {
            system_prompt: String::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            extra_tool_schemas: Vec::new(),
            model: "test-model".to_string(),
            max_tokens: None,
            stream: true,
            thinking: None,
        }
    }

    fn options() -> RequestOptions {
        RequestOptions {
            provider: "test".to_string(),
            api_key: String::new(),
            auth_mode: ProviderAuthMode::ApiKey,
            auth_account_id: None,
            base_url: "https://example.com".to_string(),
            headers: HashMap::new(),
            cancel: CancellationToken::new(),
            retry_callback: None,
            max_retries: 0,
            retry_base_delay_ms: 0,
            max_retry_delay_ms: 0,
        }
    }

    #[tokio::test]
    async fn default_complete_collects_events_until_the_stream_closes() {
        let events = StreamingProvider { fail: false }
            .complete(request(), options())
            .await
            .expect("default completion should collect the stream");

        assert_eq!(events.len(), 3);
        assert!(matches!(
            &events[0],
            StreamEvent::TextDelta { text } if text == "first"
        ));
        assert!(matches!(
            &events[1],
            StreamEvent::TextDelta { text } if text == "second"
        ));
        assert!(matches!(events[2], StreamEvent::Done));
    }

    #[tokio::test]
    async fn default_complete_propagates_stream_errors() {
        let error = StreamingProvider { fail: true }
            .complete(request(), options())
            .await
            .expect_err("stream errors should be returned");

        assert!(matches!(
            error,
            KordiError::Provider(message) if message == "stream failed"
        ));
    }
}
