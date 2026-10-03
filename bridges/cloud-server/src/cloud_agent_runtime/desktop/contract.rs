//! The context contract a desktop executor declares.
//!
//! Contract 1 is the legacy executor: it builds agent context from its own
//! local cache, so it cannot apply a conversation's AI access settings.
//! Contract 2 executors use the history the server sends with the claim
//! (`serverContext`), which the same context policy as the cloud runner
//! builds. The server sends it wherever the conversation's AI access settings
//! filter the run's history; elsewhere the executor keeps its local history.
//! A legacy executor is refused wherever its local context could include
//! messages the run may not use.

use std::sync::OnceLock;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use sqlx_postgres::PgPool;

use crate::cloud_agent_runtime::runs::context_policy::needs_filtered_context;
use crate::cloud_agent_runtime::runs::{
    context_history_for_claim, error_response, ClaimRunRequest, RunResult,
};

/// The contract current desktop executors implement.
pub(crate) const DESKTOP_CONTEXT_CONTRACT: u8 = 2;
const LEGACY_DESKTOP_ENV: &str = "KORDI_AGENT_CONTEXT_LEGACY_DESKTOP";
pub(super) const UPDATE_REQUIRED_MESSAGE: &str = "Update Kordi on this Mac so your agent can answer here. Someone in this conversation turned on \u{201c}Don't let AI use my messages.\u{201d}";

/// Executors that send no contract are legacy executors.
pub(super) fn legacy() -> u8 {
    1
}

/// Whether legacy executors may answer other members' requests in groups that
/// share messages only with the agents they are sent to. Opt-outs are always
/// enforced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LegacyDesktopPolicy {
    Deny,
    AllowWithoutOptOuts,
}

impl LegacyDesktopPolicy {
    fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("allow_without_opt_outs") => Self::AllowWithoutOptOuts,
            _ => Self::Deny,
        }
    }

    fn configured() -> Self {
        static POLICY: OnceLock<LegacyDesktopPolicy> = OnceLock::new();
        *POLICY.get_or_init(|| Self::parse(std::env::var(LEGACY_DESKTOP_ENV).ok().as_deref()))
    }
}

/// What a legacy executor may do with a claim.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Gate {
    Allow,
    /// Answer `acquired:false`, so the requester's app claims cloud fallback.
    Quiet,
    /// Tell the owner to update: their own request cannot run here.
    UpdateRequired,
}

pub(super) fn decide(
    contract: u8,
    own_request: bool,
    mentions_group: bool,
    excluded: bool,
    policy: LegacyDesktopPolicy,
) -> Gate {
    if contract >= DESKTOP_CONTEXT_CONTRACT {
        return Gate::Allow;
    }
    match (own_request, excluded) {
        (true, true) => Gate::UpdateRequired,
        (false, true) => Gate::Quiet,
        (false, false) if mentions_group && policy == LegacyDesktopPolicy::Deny => Gate::Quiet,
        _ => Gate::Allow,
    }
}

async fn gate_for(pool: &PgPool, run: &ClaimRunRequest, contract: u8) -> RunResult<Gate> {
    if contract >= DESKTOP_CONTEXT_CONTRACT {
        return Ok(Gate::Allow);
    }
    let (mentions_group, excluded) = needs_filtered_context(
        pool,
        &run.session_id,
        &run.owner_account_id,
        &run.requester_account_id,
    )
    .await?;
    Ok(decide(
        contract,
        run.requester_account_id == run.owner_account_id,
        mentions_group,
        excluded,
        LegacyDesktopPolicy::configured(),
    ))
}

/// The response refusing this claim, or `None` when the executor may claim it.
pub(super) async fn gate(
    pool: &PgPool,
    run: &ClaimRunRequest,
    contract: u8,
) -> RunResult<Option<Response>> {
    Ok(match gate_for(pool, run, contract).await? {
        Gate::Allow => None,
        Gate::Quiet => Some(
            axum::Json(json!({
                "runId": null,
                "acquired": false,
                "reason": "desktop_update_required",
            }))
            .into_response(),
        ),
        Gate::UpdateRequired => Some(error_response(
            "desktop_update_required",
            UPDATE_REQUIRED_MESSAGE,
            StatusCode::CONFLICT,
        )),
    })
}

/// The lowest contract a ready desktop needs for this claim to wait for it.
/// A legacy executor that would refuse another member's request must not
/// delay cloud fallback.
pub(super) async fn min_ready_contract(pool: &PgPool, run: &ClaimRunRequest) -> RunResult<i16> {
    if run.requester_account_id == run.owner_account_id {
        return Ok(i16::from(legacy()));
    }
    Ok(match gate_for(pool, run, legacy()).await? {
        Gate::Allow => i16::from(legacy()),
        Gate::Quiet | Gate::UpdateRequired => i16::from(DESKTOP_CONTEXT_CONTRACT),
    })
}

/// Whether a run's history needs the server's filter: a mention-only group,
/// or a member's opt-out that applies to this run. Otherwise nothing is left
/// out, and a current executor keeps its local history, which agent
/// conversations need and which direct conversations keep longer than the
/// server's eight-message preview.
pub(super) fn sends_server_context(mentions_group: bool, excluded: bool) -> bool {
    mentions_group || excluded
}

/// Adds the server-built history to an acquired contract-2 claim whose
/// history the conversation's AI access settings filter.
pub(super) async fn with_server_context(
    pool: &PgPool,
    run: &ClaimRunRequest,
    contract: u8,
    mut value: Value,
) -> RunResult<Value> {
    if contract < DESKTOP_CONTEXT_CONTRACT || value["acquired"] != true {
        return Ok(value);
    }
    let (mentions_group, excluded) = needs_filtered_context(
        pool,
        &run.session_id,
        &run.owner_account_id,
        &run.requester_account_id,
    )
    .await?;
    if !sends_server_context(mentions_group, excluded) {
        return Ok(value);
    }
    let messages = context_history_for_claim(pool, run).await?;
    value["serverContext"] = json!({
        "contract": DESKTOP_CONTEXT_CONTRACT,
        "historyScope": if mentions_group { "mentions" } else { "recent" },
        "messages": messages,
    });
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_executors_always_claim() {
        for own in [true, false] {
            for mentions in [true, false] {
                for excluded in [true, false] {
                    assert_eq!(
                        decide(2, own, mentions, excluded, LegacyDesktopPolicy::Deny),
                        Gate::Allow
                    );
                }
            }
        }
    }

    #[test]
    fn legacy_executors_are_refused_where_their_context_could_include_left_out_messages() {
        let deny = LegacyDesktopPolicy::Deny;
        let allow = LegacyDesktopPolicy::AllowWithoutOptOuts;
        // The owner's own request runs with legacy context while no one opted out.
        assert_eq!(decide(1, true, true, false, deny), Gate::Allow);
        assert_eq!(decide(1, true, false, false, deny), Gate::Allow);
        // With an opt-out, the owner sees a visible failure, and another
        // member's request goes to cloud fallback.
        assert_eq!(decide(1, true, true, true, deny), Gate::UpdateRequired);
        assert_eq!(decide(1, true, false, true, allow), Gate::UpdateRequired);
        assert_eq!(decide(1, false, false, true, allow), Gate::Quiet);
        // Another member's request in a mention-only group.
        assert_eq!(decide(1, false, true, false, deny), Gate::Quiet);
        assert_eq!(decide(1, false, true, false, allow), Gate::Allow);
        assert_eq!(decide(1, false, false, false, deny), Gate::Allow);
    }

    #[test]
    fn server_context_is_sent_only_where_settings_filter_history() {
        assert!(sends_server_context(true, false));
        assert!(sends_server_context(false, true));
        assert!(sends_server_context(true, true));
        // Agent conversations, direct conversations and recent groups with
        // no opt-out that applies keep the executor's local history.
        assert!(!sends_server_context(false, false));
    }

    #[test]
    fn the_legacy_policy_defaults_to_deny() {
        assert_eq!(LegacyDesktopPolicy::parse(None), LegacyDesktopPolicy::Deny);
        assert_eq!(
            LegacyDesktopPolicy::parse(Some("allow")),
            LegacyDesktopPolicy::Deny
        );
        assert_eq!(
            LegacyDesktopPolicy::parse(Some(" allow_without_opt_outs ")),
            LegacyDesktopPolicy::AllowWithoutOptOuts
        );
    }
}
