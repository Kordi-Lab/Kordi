//! Credential resolution helpers split by concern.

use super::*;

mod auth_sources;
mod models;
mod oauth_refresh;

pub use auth_sources::{
    AuthSource, ProviderAuthOptionSummary, add_cached_github_copilot_models, auth_source,
    authenticated_providers, authenticated_providers_for_settings, provider_auth_option_summaries,
    provider_auth_status_summary, provider_configured_for_settings,
    provider_model_selection_detail,
};
pub use models::{
    authenticated_model_candidates, available_model_for_provider,
    model_candidates_for_provider_auth_mode, model_catalog_rank, model_id_allowed_for_active_auth,
    preferred_available_model_for_provider, preferred_startup_provider_and_model,
};
pub use oauth_refresh::{
    ResolvedProviderAuth, resolve_provider_auth, resolve_provider_auth_choice,
    save_oauth_credentials,
};
