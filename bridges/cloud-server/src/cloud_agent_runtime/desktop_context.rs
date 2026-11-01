//! Frozen conversation scope and connector tools for a desktop lease.
use super::*;

pub(super) async fn context_scope_response(state: &ServerState, mut value: Value) -> Response {
    let pool = state.db_pool();
    if value["acquired"] == true {
        let run_id = value["runId"].as_str().unwrap_or_default().to_string();
        match query_as::<_, (String, String, String)>(
            "SELECT session_id, run_trigger, connector_audience FROM cloud_agent_fallback_runs WHERE run_id=$1",
        )
        .bind(&run_id)
        .fetch_one(pool)
        .await
        {
            Ok((scope, trigger, audience)) => {
                value["contextSessionId"] = json!(scope);
                // The desktop lease carries the same connector descriptors
                // as a cloud lease; the broker checks calls against them.
                value["trigger"] = json!(crate::connectors::models::RunTrigger::parse(&trigger));
                value["connectorAudience"] =
                    json!(crate::connectors::models::ConnectorAudience::parse(&audience));
                value["connectorTools"] = json!(
                    crate::connectors::delivery::deliver_to_run(
                        pool,
                        &state.connectors().providers,
                        &run_id,
                    )
                    .await
                );
            }
            Err(error) => {
                return run_error_response(
                    "desktop context scope",
                    "Could not resolve conversation context.",
                    error.into(),
                )
            }
        }
    }
    Json(value).into_response()
}
