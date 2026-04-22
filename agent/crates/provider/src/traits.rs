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
    ) -> KordiResult<Vec<StreamEvent>>;

    /// Streaming: sends events to channel as they arrive.
    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()>;
}
