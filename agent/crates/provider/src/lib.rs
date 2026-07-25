//! Provider integrations, streaming abstractions, and model resolution for Kordi.

pub mod anthropic;
mod error;
pub mod google;
pub mod openai;
pub mod registry;
pub mod resolver;
mod retry;
mod streaming;
mod traits;
mod transforms;
mod types;

pub use error::{
    ProviderError, ProviderErrorFormat, ProviderHttpError, ProviderTransportKind, Result,
    is_retryable_error_message as is_retryable_provider_error_message, unexpected_response,
    unexpected_response_with_sensitive_values,
};
pub use streaming::{CollectedResponse, CollectedToolCall};
pub use traits::Provider;
pub use types::{
    CompletionRequest, ProviderAuthMode, ProviderRetryEvent, RequestOptions, RetryCallback,
    StreamEvent, UsageInfo,
};
