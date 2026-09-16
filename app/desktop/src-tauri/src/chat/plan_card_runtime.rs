/// Unlike calendar reads, a plan card is inherently shared conversation
/// data — there is no private-disclosure scope to authorize per message,
/// so this needs only the signed-in account's own credentials.
pub(super) fn build() -> Option<kordi_tools::plan_card::PlanCardRuntime> {
    let session = crate::cloud_session::cloud_session_load().ok()??;
    if session.token.trim().is_empty() {
        return None;
    }
    let api_base = crate::cloud_api_base_url_from_env().ok()?;
    Some(kordi_tools::plan_card::http_runtime(
        api_base,
        session.token,
    ))
}
