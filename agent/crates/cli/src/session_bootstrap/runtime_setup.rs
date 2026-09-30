use super::*;

pub(crate) struct SessionRuntimeSetup {
    pub conn: rusqlite::Connection,
    pub session_id: String,
    pub provider: Arc<dyn Provider>,
    pub model: kordi_provider::registry::Model,
    pub auth: Option<crate::login::ResolvedProviderAuth>,
    /// Credential material supplied for one desktop turn; never written to the session store.
    pub ephemeral_auth: Option<crate::login::ResolvedProviderAuth>,
    pub ephemeral_base_url: Option<String>,
    pub ephemeral_original_model_api: Option<kordi_provider::registry::ApiType>,
    #[allow(dead_code)]
    pub auth_choice_override: Option<SessionAuthChoiceOverride>,
    pub api_key: String,
    pub base_url: String,
    pub headers: std::collections::HashMap<String, String>,
    pub tool_registry: ToolRegistry,
    pub tool_selection: ToolSelection,
    pub tool_ctx: ToolContext,
    pub system_prompt: String,
    pub base_system_prompt: String,
    pub thinking_level: String,
    pub compaction_enabled: bool,
    pub compaction_reserve_tokens: u64,
    pub compaction_keep_recent_tokens: u64,
    pub retry_enabled: bool,
    pub retry_max_retries: u32,
    pub retry_base_delay_ms: u64,
    pub retry_max_delay_ms: u64,
    /// Whether the session row has been created in the DB yet.
    pub session_created: bool,
    /// Cached sibling DB connection for the turn runner (avoid opening a new one each turn).
    pub sibling_conn: Option<std::sync::Arc<tokio::sync::Mutex<rusqlite::Connection>>>,
    pub extension_commands: ExtensionCommandRegistry,
    pub extension_bootstrap: ExtensionBootstrap,
    #[allow(dead_code)]
    pub slash_command_items: Vec<RuntimeSlashCommandItem>,
    pub request_metrics_tracker: std::sync::Arc<tokio::sync::Mutex<RequestMetricsTracker>>,
    pub request_metrics_log_path: Option<std::path::PathBuf>,
}
