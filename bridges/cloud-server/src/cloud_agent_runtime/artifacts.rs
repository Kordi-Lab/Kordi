use axum::http::StatusCode;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::attachments::{presign_upload_url, S3Config};

mod messages;

use messages::attach_response_artifact;
pub use messages::{ensure_response_message, update_response_message_body};

pub const MAX_ARTIFACT_EXPORT_BYTES: usize = 8 * 1024 * 1024;
const PLACEHOLDER_RESPONSE_BODY: &str = "Shared sandbox artifact.";

#[derive(Debug, Deserialize)]
pub struct ExportArtifactRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "bytesBase64")]
    pub bytes_base64: String,
}

#[derive(Debug, Serialize)]
pub struct ExportArtifactEnvelope {
    pub artifact: ExportedArtifact,
}

#[derive(Debug, Serialize)]
pub struct ExportedArtifact {
    #[serde(rename = "artifactId")]
    pub artifact_id: String,
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug)]
pub struct ExportArtifactError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: StatusCode,
}

impl ExportArtifactError {
    fn invalid(message: &'static str) -> Self {
        Self {
            code: "invalid_artifact_export",
            message,
            status: StatusCode::BAD_REQUEST,
        }
    }
}

impl ExportArtifactRequest {
    pub fn runner_id(&self) -> Option<String> {
        let value = self.runner_id.trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    pub fn validate_path(&self) -> Result<String, ExportArtifactError> {
        let value = self.sandbox_path.trim();
        if value.is_empty()
            || value.starts_with('/')
            || value.starts_with('~')
            || value.contains("../")
            || value == ".."
            || value.contains("/..")
            || value.starts_with("/Users/")
            || value.starts_with("/home/")
        {
            return Err(ExportArtifactError::invalid(
                "sandboxPath must stay inside the sandbox.",
            ));
        }
        Ok(value.to_string())
    }

    pub fn decode_bytes(&self) -> Result<(Vec<u8>, Option<String>), ExportArtifactError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(self.bytes_base64.trim())
            .map_err(|_| ExportArtifactError::invalid("bytesBase64 is invalid."))?;
        if bytes.is_empty() {
            return Err(ExportArtifactError::invalid("artifact bytes are required."));
        }
        if bytes.len() > MAX_ARTIFACT_EXPORT_BYTES {
            return Err(ExportArtifactError {
                code: "artifact_too_large",
                message: "Artifact export is too large.",
                status: StatusCode::PAYLOAD_TOO_LARGE,
            });
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if let Some(expected) = self
            .sha256_hex
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(ExportArtifactError::invalid(
                    "sha256Hex must be a 64-character hex digest.",
                ));
            }
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(ExportArtifactError::invalid(
                    "sha256Hex does not match artifact bytes.",
                ));
            }
            return Ok((bytes, Some(expected.to_ascii_lowercase())));
        }
        Ok((bytes, Some(actual)))
    }

    pub fn validated_name(&self) -> Result<String, ExportArtifactError> {
        let value = self.name.trim();
        if value.is_empty() || value.contains('/') || value.contains('\\') {
            return Err(ExportArtifactError::invalid("name must be a file name."));
        }
        Ok(value.to_string())
    }

    pub fn validated_content_type(&self) -> Result<String, ExportArtifactError> {
        let value = self.content_type.trim();
        if value.is_empty() || value.len() > 255 {
            return Err(ExportArtifactError::invalid("contentType is required."));
        }
        Ok(value.to_string())
    }
}

type RunForExport = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);

async fn run_for_export(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<RunForExport>, sqlx_core::Error> {
    query_as(
        "SELECT run_id, owner_account_id, requester_account_id, session_id, status, sandbox_id, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running', 'completed')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await
}

async fn upload_object(
    s3: &S3Config,
    object_key: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> Result<(), ExportArtifactError> {
    let url = presign_upload_url(s3, object_key).map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Could not sign artifact upload.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;
    let resp = reqwest::Client::new()
        .put(url.to_string())
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|_| ExportArtifactError {
            code: "server_error",
            message: "Could not upload artifact bytes.",
            status: StatusCode::BAD_GATEWAY,
        })?;
    if !resp.status().is_success() {
        return Err(ExportArtifactError {
            code: "server_error",
            message: "Object storage rejected artifact bytes.",
            status: StatusCode::BAD_GATEWAY,
        });
    }
    Ok(())
}

pub async fn export_run_artifact(
    pool: &PgPool,
    s3: &S3Config,
    run_id: &str,
    runner_id: &str,
    input: ExportArtifactRequest,
) -> Result<ExportedArtifact, ExportArtifactError> {
    let name = input.validated_name()?;
    let sandbox_path = input.validate_path()?;
    let content_type = input.validated_content_type()?;
    let (bytes, sha256_hex) = input.decode_bytes()?;
    let size_bytes = i64::try_from(bytes.len()).map_err(|_| ExportArtifactError {
        code: "artifact_too_large",
        message: "Artifact export is too large.",
        status: StatusCode::PAYLOAD_TOO_LARGE,
    })?;

    let Some((
        run_id,
        owner_account_id,
        requester_account_id,
        session_id,
        _status,
        sandbox_id,
        _existing_message_id,
    )) = run_for_export(pool, run_id, runner_id)
        .await
        .map_err(|_| ExportArtifactError {
            code: "server_error",
            message: "Could not load Cloud agent run.",
            status: StatusCode::INTERNAL_SERVER_ERROR,
        })?
    else {
        return Err(ExportArtifactError {
            code: "agent_run_not_found",
            message: "Cloud agent run was not found for this runner.",
            status: StatusCode::NOT_FOUND,
        });
    };
    let Some(sandbox_id) = sandbox_id else {
        return Err(ExportArtifactError {
            code: "agent_run_not_found",
            message: "Cloud agent run has no sandbox.",
            status: StatusCode::NOT_FOUND,
        });
    };

    let attachment_id = format!("att_{}", Uuid::new_v4().simple());
    let artifact_id = format!("carartifact_{}", Uuid::new_v4().simple());
    let activity_id = format!("artifact_activity_{}", Uuid::new_v4().simple());
    let object_key = format!("attachments/{owner_account_id}/{attachment_id}");
    let now = Utc::now().to_rfc3339();

    upload_object(s3, &object_key, &content_type, bytes).await?;

    query("INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, size_bytes, content_type, sha256_hex, created_at, finalized_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)")
        .bind(&attachment_id)
        .bind(&owner_account_id)
        .bind(&object_key)
        .bind(size_bytes)
        .bind(&content_type)
        .bind(sha256_hex.as_deref())
        .bind(&now)
        .execute(pool)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not record exported attachment.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    let message_id = ensure_response_message(
        pool,
        &run_id,
        &owner_account_id,
        &requester_account_id,
        &session_id,
        PLACEHOLDER_RESPONSE_BODY,
    )
    .await
    .map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Could not create durable run response message.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;
    attach_response_artifact(
        pool,
        &message_id,
        &attachment_id,
        &name,
        &content_type,
        size_bytes,
    )
    .await
    .map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Could not link exported attachment to the durable response.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;

    let canonical_message_id = Uuid::parse_str(&message_id).map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Durable response identity is invalid.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;
    let mut tx = pool.begin().await.map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Could not start artifact export transaction.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;

    query("INSERT INTO cloud_agent_run_artifacts (artifact_id, run_id, sandbox_id, attachment_id, message_id, canonical_message_id, sandbox_path, name, content_type, size_bytes, sha256_hex, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")
        .bind(&artifact_id)
        .bind(&run_id)
        .bind(&sandbox_id)
        .bind(&attachment_id)
        .bind(&message_id)
        .bind(canonical_message_id)
        .bind(&sandbox_path)
        .bind(&name)
        .bind(&content_type)
        .bind(size_bytes)
        .bind(sha256_hex.as_deref())
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not record run artifact.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    query("INSERT INTO cloud_session_artifacts (artifact_activity_id, session_id, artifact_id, name, path, kind, category, summary, created_by_account_id, source_message_id, attachment_id, content_type, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'file', 'artifact', $6, $7, $8, $9, $10, $11, $12, $12) ON CONFLICT (session_id, artifact_id) DO NOTHING")
        .bind(&activity_id)
        .bind(&session_id)
        .bind(&artifact_id)
        .bind(&name)
        .bind(&sandbox_path)
        .bind(format!("Exported from Cloud sandbox path `{sandbox_path}`."))
        .bind(&owner_account_id)
        .bind(&message_id)
        .bind(&attachment_id)
        .bind(&content_type)
        .bind(size_bytes)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not record session artifact.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    tx.commit().await.map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Could not commit artifact export.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;

    Ok(ExportedArtifact {
        artifact_id,
        attachment_id,
        run_id,
        message_id,
        name,
        sandbox_path,
        content_type,
        size_bytes,
        sha256_hex,
        created_at: now,
    })
}
