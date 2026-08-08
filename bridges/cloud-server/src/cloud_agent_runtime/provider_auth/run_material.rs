use super::*;

#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterialEnvelope {
    #[serde(rename = "providerAuth")]
    pub provider_auth: RunnerProviderAuthMaterial,
}

#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRunnerProviderAuthRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub payload: Value,
}

#[derive(Debug)]
pub enum ProviderAuthForRunResult {
    Found(RunnerProviderAuthMaterial),
    RunNotFound,
    ProviderAuthNotFound,
}

#[derive(Debug)]
pub enum RefreshProviderAuthForRunResult {
    Refreshed {
        account_id: String,
        material: RunnerProviderAuthMaterial,
    },
    RunNotFound,
    SnapshotNotFound,
}

pub async fn provider_auth_for_run(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    run_id: &str,
    runner_id: &str,
) -> Result<ProviderAuthForRunResult, sqlx_core::Error> {
    let run: Option<(String, Option<String>)> = query_as(
        "SELECT owner_account_id, target_agent_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, target_agent_id)) = run else {
        return Ok(ProviderAuthForRunResult::RunNotFound);
    };

    let agent_route: Option<(Option<String>, Option<String>, Option<String>)> =
        match target_agent_id.as_deref() {
            Some(agent_id) => {
                query_as(
                    "SELECT NULLIF(BTRIM(model_routing_json->>'defaultAuthProvider'), ''), \
                        NULLIF(BTRIM(model_routing_json->>'defaultAuthChoice'), ''), \
                        NULLIF(BTRIM(model_routing_json->>'defaultModel'), '') \
                 FROM cloud_agent_definitions \
                 WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
                )
                .bind(agent_id)
                .bind(&owner_account_id)
                .fetch_optional(pool)
                .await?
            }
            None => None,
        };
    let (route_provider, route_auth_choice, route_model) =
        agent_route.unwrap_or((None, None, None));
    let route_provider = route_provider
        .as_deref()
        .map(normalize_snapshot_provider)
        .map(ToString::to_string);

    let mut row: Option<(String, String, String, Vec<u8>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, encrypted_payload \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND encryption_key_id = $2 AND revoked_at IS NULL \
           AND ($3::TEXT IS NULL OR provider = $3 \
                OR ($3 = 'openai' AND provider = 'openai-codex')) \
           AND ($4::TEXT IS NULL OR auth_choice = $4) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&owner_account_id)
    .bind(cipher.key_id())
    .bind(route_provider.as_deref())
    .bind(route_auth_choice.as_deref())
    .fetch_optional(pool)
    .await?;
    if row.is_none() && route_provider.is_some() && route_auth_choice.is_some() {
        let candidates: Vec<(String, String, String, Vec<u8>)> = query_as(
            "SELECT snapshot_id, provider, auth_choice, encrypted_payload \
             FROM cloud_agent_provider_auth_snapshots \
             WHERE account_id = $1 AND encryption_key_id = $2 AND revoked_at IS NULL \
               AND (provider = $3 OR ($3 = 'openai' AND provider = 'openai-codex')) \
             ORDER BY created_at DESC LIMIT 2",
        )
        .bind(&owner_account_id)
        .bind(cipher.key_id())
        .bind(route_provider.as_deref())
        .fetch_all(pool)
        .await?;
        if candidates.len() == 1 {
            row = candidates.into_iter().next();
        }
    }
    let Some((snapshot_id, provider, auth_choice, encrypted_payload)) = row else {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    };

    let plaintext = cipher
        .decrypt(&encrypted_payload)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let mut payload: Value = serde_json::from_slice(&plaintext)
        .map_err(|err| sqlx_core::Error::Decode(Box::new(err)))?;
    if let Some(model) = route_model {
        if let Some(object) = payload.as_object_mut() {
            object.insert("model".to_string(), Value::String(model));
        }
    }
    record_snapshot_used(pool, &snapshot_id, &owner_account_id, Some(run_id)).await?;

    Ok(ProviderAuthForRunResult::Found(
        RunnerProviderAuthMaterial {
            snapshot_id,
            provider,
            auth_choice,
            payload,
        },
    ))
}

pub async fn refresh_provider_auth_for_run(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    run_id: &str,
    runner_id: &str,
    snapshot_id: &str,
    payload: Value,
) -> Result<RefreshProviderAuthForRunResult, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let run: Option<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((owner_account_id,)) = run else {
        return Ok(RefreshProviderAuthForRunResult::RunNotFound);
    };

    let payload_bytes =
        serde_json::to_vec(&payload).map_err(|err| sqlx_core::Error::Encode(Box::new(err)))?;
    let encrypted_payload = cipher
        .encrypt(&payload_bytes)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let row: Option<(String, String)> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET encrypted_payload = $4 \
         WHERE snapshot_id = $1 AND account_id = $2 AND encryption_key_id = $3 \
           AND revoked_at IS NULL \
         RETURNING provider, auth_choice",
    )
    .bind(snapshot_id)
    .bind(&owner_account_id)
    .bind(cipher.key_id())
    .bind(encrypted_payload)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((provider, auth_choice)) = row else {
        return Ok(RefreshProviderAuthForRunResult::SnapshotNotFound);
    };
    insert_audit_in_tx(
        &mut tx,
        snapshot_id,
        &owner_account_id,
        Some(run_id),
        "refreshed",
        &Utc::now().to_rfc3339(),
    )
    .await?;
    tx.commit().await?;

    Ok(RefreshProviderAuthForRunResult::Refreshed {
        account_id: owner_account_id,
        material: RunnerProviderAuthMaterial {
            snapshot_id: snapshot_id.to_string(),
            provider,
            auth_choice,
            payload,
        },
    })
}

fn normalize_snapshot_provider(provider: &str) -> &str {
    match provider.trim() {
        "openai-codex" => "openai",
        "anthropic-oauth" => "anthropic",
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_snapshot_provider;

    #[test]
    fn provider_aliases_match_account_snapshots() {
        assert_eq!(normalize_snapshot_provider("openai-codex"), "openai");
        assert_eq!(normalize_snapshot_provider("anthropic-oauth"), "anthropic");
        assert_eq!(
            normalize_snapshot_provider("github-copilot"),
            "github-copilot"
        );
    }
}
