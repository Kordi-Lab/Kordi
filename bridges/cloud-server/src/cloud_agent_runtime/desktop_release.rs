//! Hand-back of a run whose Mac could not start its turn.
//!
//! The owner's Mac runs a request while it is online. When it claims a run but
//! fails before a local turn starts, for example because a cloud call timed
//! out, it hands the run back instead of failing it, and the cloud runner
//! answers at once. A run the cloud cannot answer stays with the Mac, which
//! then ends it with a reply that says why.
use super::*;

/// Hands this device's claimed run back to the cloud runner. `released` is
/// `false` when the run stays with this device.
pub(in crate::cloud_agent_runtime) async fn release(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(run_id): Path<String>,
    Json(input): Json<RenewalInput>,
) -> Response {
    let executor = executor(&session, input.claim_id);
    // An import runs only on its Mac: a release ends it instead.
    if super::super::import_runs::is_import_run(&run_id) {
        let finish = super::super::import_runs::finish;
        return match finish(
            state.db_pool(),
            &run_id,
            &session.account_id,
            &executor,
            false,
        )
        .await
        {
            Ok(released) => Json(json!({ "released": released })).into_response(),
            Err(error) => run_error_response(
                "release desktop run",
                "Could not end the import.",
                error.into(),
            ),
        };
    }
    match super::super::runs::hand_back_to_cloud(
        state.db_pool(),
        &run_id,
        &session.account_id,
        &executor,
    )
    .await
    {
        Ok(released) => Json(json!({ "released": released })).into_response(),
        Err(error) => run_error_response(
            "release desktop run",
            "Could not hand the request back to the cloud.",
            error,
        ),
    }
}
