use std::sync::Arc;

use anyhow::{Result, anyhow};
use chrono::Utc;
use kordi_core::types::{CompactionSettings, EntryBase, EntryId, SessionEntry};
use kordi_provider::{Provider, ProviderAuthMode};
use kordi_session::store::EntryRow;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub(crate) struct ExecutedCompaction {
    pub tokens_before: u64,
    pub summarized_count: usize,
    pub kept_count: usize,
}

pub(crate) struct ExecuteSessionCompactionRequest<'a> {
    pub entries: Vec<EntryRow>,
    pub parent_id: Option<EntryId>,
    pub db_path: std::path::PathBuf,
    pub session_id: &'a str,
    pub provider: Arc<dyn Provider>,
    pub model_id: &'a str,
    pub api_key: &'a str,
    pub auth_mode: ProviderAuthMode,
    pub auth_account_id: Option<String>,
    pub base_url: &'a str,
    pub headers: &'a std::collections::HashMap<String, String>,
    pub settings: &'a CompactionSettings,
    pub custom_instructions: Option<&'a str>,
    pub cancel: CancellationToken,
}

pub(crate) fn compaction_auth_options(
    auth: Option<&crate::login::ResolvedProviderAuth>,
) -> (ProviderAuthMode, Option<String>) {
    let auth_mode = auth
        .map(|auth| match auth.method {
            crate::login::ProviderAuthMethod::OAuth => ProviderAuthMode::OAuth,
            crate::login::ProviderAuthMethod::ApiKey => ProviderAuthMode::ApiKey,
        })
        .unwrap_or(ProviderAuthMode::ApiKey);
    let auth_account_id = auth.and_then(|auth| auth.account_id.clone());
    (auth_mode, auth_account_id)
}

pub(crate) async fn execute_session_compaction(
    request: ExecuteSessionCompactionRequest<'_>,
) -> Result<ExecutedCompaction> {
    let ExecuteSessionCompactionRequest {
        entries,
        parent_id,
        db_path,
        session_id,
        provider,
        model_id,
        api_key,
        auth_mode,
        auth_account_id,
        base_url,
        headers,
        settings,
        custom_instructions,
        cancel,
    } = request;
    let prep = kordi_session::compaction::prepare_compaction(&entries, settings)
        .ok_or_else(|| anyhow!("Nothing to compact"))?;

    let summarized_count = prep.messages_to_summarize.len();
    let kept_count = prep.kept_messages.len();

    let result = kordi_session::compaction::compact(kordi_session::compaction::CompactionRequest {
        preparation: &prep,
        provider: provider.as_ref(),
        model: model_id,
        api_key,
        auth_mode,
        auth_account_id: auth_account_id.as_deref(),
        base_url,
        headers,
        custom_instructions,
        cancel,
    })
    .await?;

    let details = serde_json::json!({
        "summarizedCount": summarized_count,
        "keptCount": kept_count,
        "readFiles": result.read_files,
        "modifiedFiles": result.modified_files,
    });

    let compaction_entry = SessionEntry::Compaction {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id,
            timestamp: Utc::now(),
        },
        summary: result.summary.clone(),
        first_kept_entry_id: EntryId(result.first_kept_entry_id.clone()),
        tokens_before: result.tokens_before,
        details: Some(details),
        from_plugin: false,
    };

    let append_conn = kordi_session::store::open_db(&db_path)?;
    kordi_session::store::append_entry(&append_conn, session_id, &compaction_entry)?;

    Ok(ExecutedCompaction {
        tokens_before: result.tokens_before,
        summarized_count,
        kept_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved_auth(
        method: crate::login::ProviderAuthMethod,
        account_id: Option<&str>,
    ) -> crate::login::ResolvedProviderAuth {
        crate::login::ResolvedProviderAuth {
            source: crate::login::AuthSource::KordiAuth,
            credential_provider: "openai".to_string(),
            method,
            credential: "credential".to_string(),
            account_id: account_id.map(ToString::to_string),
            account_label: None,
            authority: None,
        }
    }

    #[test]
    fn compaction_auth_options_preserve_oauth_account() {
        let auth = resolved_auth(crate::login::ProviderAuthMethod::OAuth, Some("acct-123"));

        let (mode, account_id) = compaction_auth_options(Some(&auth));

        assert_eq!(mode, ProviderAuthMode::OAuth);
        assert_eq!(account_id.as_deref(), Some("acct-123"));
    }

    #[test]
    fn compaction_auth_options_default_to_api_key() {
        let (mode, account_id) = compaction_auth_options(None);

        assert_eq!(mode, ProviderAuthMode::ApiKey);
        assert_eq!(account_id, None);
    }
}
