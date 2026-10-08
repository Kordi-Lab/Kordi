//! Token broker: the only path from a run to a connector credential.
//!
//! A runner names a connector tool; the broker checks ownership, the agent
//! grant, and the tool group against the run trigger, then decrypts the
//! secret, refreshes it when needed, executes the call through the provider,
//! audits it, and returns only the result.

use chrono::{DateTime, Utc};
use sqlx_core::executor::Executor;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipher;

use super::models::{
    allowed_tool_groups, AuditOutcome, BrokerCallRequest, BrokerCallResponse, ConnectorRecord,
    ConnectorStatus, ConnectorToolGroup, RunTrigger,
};
use super::providers::{ConnectorProvider, ConnectorSecret, ProviderError};
use super::refresh::{refresh_if_needed, RefreshFailure};
use super::store::{self, NewAuditEntry, SealedSecret};
use super::ConnectorRuntime;

/// AES-GCM nonce length used by the provider-auth cipher.
const CIPHER_NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("connector encryption is not configured")]
    CipherUnavailable,
    #[error("connector secret could not be encrypted or decrypted")]
    Crypto,
    #[error("connector secret is missing")]
    Missing,
    #[error(transparent)]
    Database(#[from] sqlx_core::Error),
}

/// Numeric key version from a cipher key id such as `env:v1`; 1 otherwise.
pub(crate) fn key_version_from_id(key_id: &str) -> i32 {
    key_id
        .rsplit_once(['v', 'V'])
        .and_then(|(_, digits)| digits.parse::<i32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1)
}

pub(crate) fn seal_secret(
    cipher: &dyn ProviderAuthCipher,
    secret: &ConnectorSecret,
) -> Result<SealedSecret, SecretError> {
    let sealed = cipher
        .encrypt(secret.access_token.as_bytes())
        .map_err(|_| SecretError::Crypto)?;
    if sealed.len() <= CIPHER_NONCE_LEN {
        return Err(SecretError::Crypto);
    }
    let (nonce, ciphertext) = sealed.split_at(CIPHER_NONCE_LEN);
    let refresh_ciphertext = secret
        .refresh_token
        .as_deref()
        .map(|refresh| cipher.encrypt(refresh.as_bytes()))
        .transpose()
        .map_err(|_| SecretError::Crypto)?;
    Ok(SealedSecret {
        ciphertext: ciphertext.to_vec(),
        nonce: nonce.to_vec(),
        key_version: key_version_from_id(cipher.key_id()),
        refresh_ciphertext,
        expires_at: secret.expires_at,
    })
}

pub(crate) fn open_secret(
    cipher: &dyn ProviderAuthCipher,
    sealed: &SealedSecret,
) -> Result<ConnectorSecret, SecretError> {
    let mut combined = Vec::with_capacity(sealed.nonce.len() + sealed.ciphertext.len());
    combined.extend_from_slice(&sealed.nonce);
    combined.extend_from_slice(&sealed.ciphertext);
    let decrypt = |bytes: &[u8]| -> Result<String, SecretError> {
        let plain = cipher.decrypt(bytes).map_err(|_| SecretError::Crypto)?;
        String::from_utf8(plain).map_err(|_| SecretError::Crypto)
    };
    Ok(ConnectorSecret {
        access_token: decrypt(&combined)?,
        refresh_token: sealed
            .refresh_ciphertext
            .as_deref()
            .map(decrypt)
            .transpose()?,
        expires_at: sealed.expires_at,
    })
}

type SecretRow = (
    Vec<u8>,
    Vec<u8>,
    i32,
    Option<Vec<u8>>,
    Option<DateTime<Utc>>,
);

/// The only function that reads `cloud_connector_secrets`.
///
/// Callers are limited to this broker, its refresh step
/// (`connectors::refresh`), and `connectors::oauth` (provider revoke on
/// disconnect). Do not add other readers: every other module must go through
/// the broker so tokens never leave the server.
pub(super) async fn read_sealed_secret<'e, E>(
    executor: E,
    connector_id: &str,
) -> Result<Option<SealedSecret>, sqlx_core::Error>
where
    E: Executor<'e, Database = Postgres>,
{
    let row: Option<SecretRow> = query_as(
        "SELECT ciphertext, nonce, key_version, refresh_ciphertext, expires_at \
         FROM cloud_connector_secrets WHERE connector_id = $1",
    )
    .bind(connector_id)
    .fetch_optional(executor)
    .await?;
    Ok(row.map(
        |(ciphertext, nonce, key_version, refresh_ciphertext, expires_at)| SealedSecret {
            ciphertext,
            nonce,
            key_version,
            refresh_ciphertext,
            expires_at,
        },
    ))
}

/// Loads and decrypts the secret for `connector_id`.
pub(super) async fn load_secret(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    connector_id: &str,
) -> Result<ConnectorSecret, SecretError> {
    let sealed = read_sealed_secret(pool, connector_id)
        .await?
        .ok_or(SecretError::Missing)?;
    open_secret(cipher, &sealed)
}

/// Error codes the broker returns. The HTTP route maps them to statuses.
pub mod codes {
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const NOT_FOUND: &str = "connector_not_found";
    pub const NOT_CONNECTED: &str = "connector_not_connected";
    pub const AGENT_NOT_GRANTED: &str = "agent_not_granted";
    pub const UNKNOWN_TOOL: &str = "unknown_tool";
    pub const ACT_DISABLED: &str = "act_disabled";
    pub const BLOCKED_BACKGROUND: &str = "blocked_background";
    pub const UNAVAILABLE: &str = "connector_unavailable";
    pub const PROVIDER_FAILED: &str = "provider_failed";
    pub const SERVER_ERROR: &str = "server_error";
}

struct AuditContext<'a> {
    pool: &'a PgPool,
    connector: &'a ConnectorRecord,
    request: &'a BrokerCallRequest,
}

impl AuditContext<'_> {
    async fn write(&self, group: ConnectorToolGroup, outcome: AuditOutcome, summary: &str) {
        let result = store::insert_audit(
            self.pool,
            NewAuditEntry {
                connector_id: &self.connector.connector_id,
                account_id: &self.connector.account_id,
                run_id: Some(self.request.lease_id.trim()),
                agent_id: Some(self.request.agent_id.trim()),
                tool: self.request.tool.trim(),
                tool_group: group,
                outcome,
                summary,
            },
        )
        .await;
        if let Err(error) = result {
            eprintln!(
                "[connectors] audit {} for {}: {error}",
                outcome.as_str(),
                self.connector.connector_id
            );
        }
    }
}

fn reject(code: &str, message: impl Into<String>) -> Box<BrokerCallResponse> {
    Box::new(BrokerCallResponse::failure(code, message))
}

fn require_field<'a>(value: &'a str, name: &str) -> Result<&'a str, Box<BrokerCallResponse>> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return Err(reject(
            codes::INVALID_REQUEST,
            format!("{name} is required."),
        ));
    }
    Ok(trimmed)
}

/// Executes one connector tool call for a run. Never returns the secret.
pub async fn call_connector_tool(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    request: &BrokerCallRequest,
) -> BrokerCallResponse {
    match call_inner(pool, runtime, request).await {
        Ok(response) => response,
        Err(response) => *response,
    }
}

async fn call_inner(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    request: &BrokerCallRequest,
) -> Result<BrokerCallResponse, Box<BrokerCallResponse>> {
    // TODO(issue 1712, PR 2): validate `lease_id` against an active lease in
    // `cloud_agent_fallback_runs` (status leased or running, unexpired,
    // owner_account_id and execution_agent_id matching), the way
    // `cloud_agent_runtime/runs/leases.rs` and `runs/context_read.rs` check
    // runner leases, and take the trigger from the lease instead of the body.
    // Until then the runner token gates this route and the account and agent
    // relationship is checked below.
    require_field(&request.lease_id, "leaseId")?;
    let account_id = require_field(&request.account_id, "accountId")?;
    let agent_id = require_field(&request.agent_id, "agentId")?;
    let connector_id = require_field(&request.connector_id, "connectorId")?;
    let tool = require_field(&request.tool, "tool")?;

    let server_error = |_| reject(codes::SERVER_ERROR, "Could not reach connector storage.");
    let not_found = || reject(codes::NOT_FOUND, "Connector not found.");

    let connector = store::load_account_connector(pool, account_id, connector_id)
        .await
        .map_err(server_error)?
        .ok_or_else(not_found)?;
    if connector.status == ConnectorStatus::Revoked {
        return Err(not_found());
    }
    if !store::agent_owned_by_account(pool, account_id, agent_id)
        .await
        .map_err(server_error)?
    {
        return Err(not_found());
    }

    let audit = AuditContext {
        pool,
        connector: &connector,
        request,
    };
    let provider = runtime.providers.get(&connector.provider);
    let group = provider
        .as_ref()
        .and_then(|provider| provider.tool_group(tool));
    let Some((provider, group)) = provider.zip(group) else {
        return Err(reject(
            codes::UNKNOWN_TOOL,
            "This connector has no such tool.",
        ));
    };

    if !store::agent_has_grant(pool, connector_id, agent_id)
        .await
        .map_err(server_error)?
    {
        audit
            .write(
                group,
                AuditOutcome::Denied,
                "Denied: this agent may not use the connector.",
            )
            .await;
        return Err(reject(
            codes::AGENT_NOT_GRANTED,
            "This agent may not use the connector.",
        ));
    }

    let allowed = allowed_tool_groups(&connector, request.trigger);
    if !allowed.contains(&group) {
        let (outcome, code, message) = if connector.status != ConnectorStatus::Connected {
            (
                AuditOutcome::Denied,
                codes::NOT_CONNECTED,
                "The connector needs to be reconnected.",
            )
        } else if group == ConnectorToolGroup::Act && request.trigger == RunTrigger::Background {
            (
                AuditOutcome::BlockedBackground,
                codes::BLOCKED_BACKGROUND,
                "Background runs cannot use tools that act.",
            )
        } else {
            (
                AuditOutcome::Denied,
                codes::ACT_DISABLED,
                "Acting through this connector is turned off.",
            )
        };
        audit
            .write(
                group,
                outcome,
                &format!("{}: {message}", outcome_label(outcome)),
            )
            .await;
        return Err(reject(code, message));
    }

    let Some(cipher) = runtime.cipher.as_deref() else {
        audit
            .write(
                group,
                AuditOutcome::Failed,
                "Failed: connector encryption is not configured.",
            )
            .await;
        return Err(reject(
            codes::UNAVAILABLE,
            "Connectors are not available on this server.",
        ));
    };
    let secret = match load_secret(pool, cipher, connector_id).await {
        Ok(secret) => secret,
        Err(error) => {
            eprintln!("[connectors] load secret for {connector_id}: {error}");
            audit
                .write(
                    group,
                    AuditOutcome::Failed,
                    "Failed: the stored credential could not be read.",
                )
                .await;
            return Err(reject(
                codes::UNAVAILABLE,
                "The connector credential could not be read. Reconnect it.",
            ));
        }
    };
    let secret =
        match refresh_if_needed(pool, cipher, provider.as_ref(), connector_id, secret).await {
            Ok(secret) => secret,
            Err(failure) => {
                audit
                    .write(
                        group,
                        AuditOutcome::Failed,
                        &format!("Failed: {}", failure.audit_phrase()),
                    )
                    .await;
                return Err(refresh_rejection(&failure));
            }
        };

    match provider.execute(tool, &request.args, &secret).await {
        Ok(result) => {
            audit
                .write(group, AuditOutcome::Completed, "Completed.")
                .await;
            Ok(BrokerCallResponse::success(result))
        }
        Err(error) => {
            if matches!(error, ProviderError::Unauthorized) {
                let _ = store::mark_needs_reauth(pool, connector_id).await;
            }
            audit
                .write(
                    group,
                    AuditOutcome::Failed,
                    &format!("Failed: {}", error.audit_phrase()),
                )
                .await;
            Err(reject(
                codes::PROVIDER_FAILED,
                provider_failure_message(&error),
            ))
        }
    }
}

fn outcome_label(outcome: AuditOutcome) -> &'static str {
    match outcome {
        AuditOutcome::BlockedBackground => "Blocked",
        AuditOutcome::Denied => "Denied",
        AuditOutcome::Failed => "Failed",
        AuditOutcome::Approved => "Approved",
        AuditOutcome::Completed => "Completed",
    }
}

fn provider_failure_message(error: &ProviderError) -> String {
    match error {
        ProviderError::Unauthorized => {
            "The provider rejected the connection. Reconnect it.".to_string()
        }
        ProviderError::UnknownTool => "This connector has no such tool.".to_string(),
        _ => "The provider request failed.".to_string(),
    }
}

fn refresh_rejection(failure: &RefreshFailure) -> Box<BrokerCallResponse> {
    match failure {
        RefreshFailure::NeedsReauth => reject(
            codes::NOT_CONNECTED,
            "The connector credential expired. Reconnect it.",
        ),
        RefreshFailure::Disconnected => reject(codes::NOT_FOUND, "Connector not found."),
        RefreshFailure::Provider(_) => reject(
            codes::PROVIDER_FAILED,
            "The provider could not refresh the connection. Try again.",
        ),
        RefreshFailure::Storage => reject(
            codes::SERVER_ERROR,
            "The refreshed credential could not be saved.",
        ),
    }
}

/// Tool descriptors a run may receive for one connector. PR 2 calls this
/// when it builds the lease.
pub fn tools_for_trigger(
    connector: &ConnectorRecord,
    provider: &dyn ConnectorProvider,
    trigger: RunTrigger,
) -> Vec<super::providers::ConnectorToolDescriptor> {
    let allowed = allowed_tool_groups(connector, trigger);
    provider
        .tools()
        .iter()
        .filter(|descriptor| allowed.contains(&descriptor.group))
        .copied()
        .collect()
}
