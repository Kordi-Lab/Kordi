//! Card builds: gather the sources the owner turned on, redact them, and
//! queue one background run on the Kordi-operated key. The run's reply
//! becomes the card when it completes.

use std::sync::Arc;

mod documents;
mod gather;
mod related;

#[cfg(test)]
pub(super) use gather::{link_url_for_tests, request_for_tests};
#[cfg(test)]
pub(super) use related::{related_ids, user_block, Candidate};

use axum::{extract::State, http::StatusCode, response::Response, Extension, Json};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::prompt::{self, Gathered};
use super::runs::{self, NewRun, CARD_PREFIX};
use super::{card, db_error, err, limited, profiles, BUILD_LIMIT};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::memory_store::ProfileTarget;
use crate::{auth::routes::CloudSession, server::ServerState};
use documents::{gather_documents, DOCUMENTS_SOURCE};
use gather::{gather, BuildRequest};

pub(super) async fn start(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<BuildRequest>,
) -> Response {
    let Some(system_agent) = state.system_agent() else {
        return super::unavailable();
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let requested = request.profile_id.as_deref();
    let existing = match profiles::resolve(pool, account, requested).await {
        Ok(profile) => profile,
        Err(response) => return *response,
    };
    if request.agents_too_long() {
        return err(
            "common_ground_invalid_build",
            "Agent files are too long.",
            StatusCode::BAD_REQUEST,
        );
    }
    // An account without a profile builds the work profile it gets below.
    let target = match &existing {
        Some(profile) => profile.memory_target(),
        None => ProfileTarget {
            profile_id: None,
            kind: "work",
        },
    };
    let (mut evidence, mut used) = match gather(pool, account, target, &request).await {
        Ok(gathered) => gathered,
        Err(error) => return db_error(error),
    };
    let candidates = match related::candidates(pool, account, target, request.memory_on()).await {
        Ok(candidates) => candidates,
        Err(error) => return db_error(error),
    };
    match gather_documents(&state, account, &request.documents).await {
        Ok(documents) if !documents.is_empty() => {
            evidence.extend(documents);
            used.push(DOCUMENTS_SOURCE.to_string());
        }
        Ok(_) => {}
        Err(error) => return db_error(error),
    }
    if evidence.is_empty() {
        return err(
            "common_ground_no_sources",
            "Choose at least one source.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(BUILD_LIMIT, account)
        .await
    {
        return limited(retry_after);
    }
    // Clients that never send a profile build the work profile.
    let mut profile = match existing {
        Some(profile) => profile,
        None => match profiles::resolve_or_create(pool, account, requested).await {
            Ok(profile) => profile,
            Err(response) => return *response,
        },
    };
    let profile_id = profile.profile_id.as_str();
    let mut system_prompt = prompt::system_prompt(&profile);
    let mut user_prompt =
        prompt::user_prompt(&Utc::now().date_naive().to_string(), &profile, &evidence);
    if !candidates.is_empty() {
        system_prompt = format!("{system_prompt}\n\n{}", related::SYSTEM_BLOCK);
        user_prompt.push_str(&related::user_block(&candidates));
    }
    let config = system_agent.config();
    let run_id = runs::new_run_id(CARD_PREFIX);
    let picks = request.picks.map(|picks| picks.cleaned());
    let result = async {
        let mut tx = pool.begin().await?;
        query(
            "INSERT INTO cloud_common_ground_cards (profile_id, account_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(profile_id)
        .bind(account)
        .execute(&mut *tx)
        .await?;
        let sql = format!(
            "UPDATE cloud_common_ground_cards card SET active_run_id = $2, build_started_at = now(),
                 build_evidence_json = $3, build_candidates_json = $4, build_error_code = NULL,
                 updated_at = now()
             WHERE card.profile_id = $1 AND NOT ({})",
            card::BUILD_IN_FLIGHT_SQL
        );
        let reserved = query(&sql)
            .bind(profile_id)
            .bind(&run_id)
            .bind(serde_json::to_value(&evidence).unwrap_or_default())
            .bind(related::stored_ids(&candidates))
            .execute(&mut *tx)
            .await?;
        if reserved.rows_affected() == 0 {
            return Ok(false);
        }
        // The picks are remembered only with a build that starts.
        if let Some(picks) = &picks {
            query(
                "UPDATE cloud_common_ground_profiles SET sources_json = $2 WHERE profile_id = $1",
            )
            .bind(profile_id)
            .bind(picks.to_json())
            .execute(&mut *tx)
            .await?;
        }
        // The member's redacted evidence is the whole prompt.
        let new_run = NewRun {
            run_id: &run_id,
            requester: account,
            prompt: user_prompt,
            system_prompt: &system_prompt,
        };
        runs::insert(&mut tx, config, new_run).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(true)
    }
    .await;
    if matches!(result, Ok(true)) && picks.is_some() {
        profile.sources = picks;
    }
    match result {
        Ok(true) => match card::owner_view(pool, account, Some(&profile)).await {
            Ok(mut view) => {
                use axum::response::IntoResponse;
                view["used"] = json!(used);
                (StatusCode::ACCEPTED, Json(view)).into_response()
            }
            Err(error) => db_error(error),
        },
        Ok(false) => err(
            "common_ground_build_in_progress",
            "Your card is already being built.",
            StatusCode::CONFLICT,
        ),
        Err(error) => db_error(error),
    }
}

/// Stores the card from a finished run. A reply that is not a card fails
/// the build instead.
pub(super) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<(String, String, Value, Option<Value>)> = query_as(
        "SELECT card.account_id, card.profile_id, card.build_evidence_json,
             card.build_candidates_json
         FROM cloud_common_ground_cards card
         JOIN cloud_agent_fallback_runs run ON run.run_id = card.active_run_id
         WHERE run.run_id = $1 AND run.claimed_by = $2 AND run.status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((account, profile_id, gathered, offered)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let gathered: Vec<Gathered> = serde_json::from_value(gathered).unwrap_or_default();
    let (topics, evidence) = match prompt::parse_reply(text, &gathered) {
        Ok(card) => card,
        Err(error) => {
            eprintln!("[common-ground] Rejected run {run_id}: {}", error.code());
            return fail(pool, run_id, Some(runner_id), error.code()).await;
        }
    };
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    // A rebuild starts with nothing hidden: the topics are new.
    query(
        "UPDATE cloud_common_ground_cards SET topics_json = $2, evidence_json = $3,
             hidden_json = '[]'::jsonb, active_run_id = NULL, build_evidence_json = NULL,
             build_candidates_json = NULL, build_error_code = NULL, built_at = now(), revision = revision + 1, updated_at = now()
         WHERE profile_id = $1 AND active_run_id = $4",
    )
    .bind(&profile_id)
    .bind(serde_json::to_value(&topics).unwrap_or_default())
    .bind(serde_json::to_value(&evidence).unwrap_or_default())
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    let related = related::related_ids(text, &offered.unwrap_or_default());
    let added = related::relate(&mut tx, &account, &profile_id, &related).await;
    super::hint(
        &mut tx,
        &account,
        "common_ground.card.updated",
        json!({ "built": true, "profileId": profile_id }),
    )
    .await?;
    tx.commit().await?;
    related::audit(pool, &account, &profile_id, added).await;
    Ok(())
}

pub(super) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    // A runner that lost its lease, or a repeated report, changes nothing.
    if !runs::mark_failed(&mut tx, run_id, runner_id, code, "Card build failed.").await? {
        return Ok(());
    }
    let account: Option<(String, String)> = query_as(
        "UPDATE cloud_common_ground_cards SET active_run_id = NULL, build_evidence_json = NULL,
             build_candidates_json = NULL, build_error_code = $2, updated_at = now()
         WHERE active_run_id = $1 RETURNING account_id, profile_id",
    )
    .bind(run_id)
    .bind(code)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((account, profile_id)) = account {
        super::hint(
            &mut tx,
            &account,
            "common_ground.card.updated",
            json!({ "built": false, "profileId": profile_id }),
        )
        .await?;
    }
    tx.commit().await
}
