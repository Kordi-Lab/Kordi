//! Runtime readiness a desktop publishes for the agents it can run.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::cloud_agent_runtime) struct ReadyInput {
    agent_ids: Vec<String>,
    /// This Mac runs digests ([`crate::digest::desktop`]).
    #[serde(default)]
    digest: bool,
    /// This Mac runs scheduled tasks ([`crate::scheduled_tasks::mac`]).
    #[serde(default)]
    scheduled: bool,
    /// This Mac runs proactive runs ([`crate::proactive::desktop`]).
    #[serde(default)]
    proactive: bool,
}

pub(in crate::cloud_agent_runtime) async fn ready(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<ReadyInput>,
) -> Response {
    if input.agent_ids.len() > 128 {
        return denied();
    }
    let result = async {
        let mut tx = state.db_pool().begin().await?;
        let desktop: Option<(String,)> = query_as("SELECT device_id FROM cloud_devices WHERE device_id=$1 AND account_id=$2 AND device_platform IN ('macos','desktop') AND revoked_at IS NULL FOR UPDATE")
            .bind(&session.device_id).bind(&session.account_id).fetch_optional(&mut *tx).await?;
        if desktop.is_none() { return Ok::<_, sqlx_core::Error>(false); }
        query("DELETE FROM cloud_agent_desktop_capabilities WHERE device_id=$1").bind(&session.device_id).execute(&mut *tx).await?;
        for agent in &input.agent_ids {
            let own: Option<(String,)> = query_as("SELECT agent_id FROM cloud_agent_definitions WHERE agent_id=$1 AND owner_account_id=$2 AND status='active'")
                .bind(agent).bind(&session.account_id).fetch_optional(&mut *tx).await?;
            if agent != &format!("cloud-agent:{}", session.account_id) && own.is_none() { return Ok(false); }
            query("INSERT INTO cloud_agent_desktop_capabilities(device_id,agent_id) VALUES($1,$2) ON CONFLICT(device_id,agent_id) DO UPDATE SET updated_at=now()")
                .bind(&session.device_id).bind(agent).execute(&mut *tx).await?;
        }
        let digest = input.digest.then_some(crate::digest::desktop::CAPABILITY);
        let scheduled = input.scheduled.then_some(crate::scheduled_tasks::mac::CAPABILITY);
        let proactive = input.proactive.then_some(crate::proactive::CAPABILITY);
        for capability in digest.into_iter().chain(scheduled).chain(proactive) {
            query("INSERT INTO cloud_agent_desktop_capabilities(device_id,agent_id) VALUES($1,$2) ON CONFLICT(device_id,agent_id) DO UPDATE SET updated_at=now()")
                .bind(&session.device_id).bind(capability).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(true)
    }.await;
    match result {
        Ok(true) => Json(json!({"ok":true})).into_response(),
        Ok(false) => denied(),
        Err(e) => run_error_response(
            "desktop readiness",
            "Could not publish runtime readiness.",
            e.into(),
        ),
    }
}
