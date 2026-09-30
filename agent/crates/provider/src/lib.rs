//! Provider integrations, streaming abstractions, and model resolution for Kordi.

pub mod anthropic;
mod error;
pub mod google;
mod images;
mod model_context;
pub mod openai;
pub mod registry;
pub mod resolver;
mod retry;
mod streaming;
mod tool_images;
mod traits;
mod transforms;
mod types;

pub use error::{
    ProviderError, ProviderErrorFormat, ProviderHttpError, ProviderTransportKind, Result,
    is_retryable_error_message as is_retryable_provider_error_message, unexpected_response,
    unexpected_response_with_sensitive_values,
};
pub use model_context::with_active_model_context;

/// Applies the connect and read timeouts that the built-in provider HTTP
/// clients use. Callers that pass their own client to a provider's
/// `with_client` apply it to that client's builder.
pub fn with_provider_timeouts(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(300))
}
pub use streaming::{CollectedResponse, CollectedToolCall};
pub use traits::Provider;
pub use types::{
    CompletionRequest, ProviderAuthMode, ProviderRetryEvent, RequestOptions, RetryCallback,
    StreamEvent, UsageInfo,
};
