use kordi_cli::desktop_runtime::DesktopRuntimeSession;
use kordi_core::types::RuntimeIdentity;

pub(super) fn build(
    runtime: &DesktopRuntimeSession,
    shared_session: Option<&str>,
) -> Option<kordi_tools::calendar::CalendarRuntime> {
    // Rebuilt every turn, including logout and cross-account speaker changes.
    let session = crate::cloud_session::cloud_session_load().ok()??;
    if session.token.trim().is_empty() {
        return None;
    }
    let identity = runtime
        .runtime_identity_context()
        .ok()?
        .map(|context| serde_json::from_str::<RuntimeIdentity>(&context.text))
        .transpose()
        .ok()?;
    let shared_session = shared_session.or_else(|| {
        let id = runtime.session_id();
        (id.starts_with("session:group:") || id.starts_with("session:direct-person:")).then_some(id)
    });
    let scope = authorized_scope(&session.account_id, identity.as_ref(), shared_session).ok()?;
    let api_base = crate::cloud_api_base_url_from_env().ok()?;
    Some(kordi_tools::calendar::http_runtime(
        api_base,
        session.token,
        scope,
    ))
}

fn authorized_scope(
    account: &str,
    identity: Option<&RuntimeIdentity>,
    shared_session: Option<&str>,
) -> Result<Option<(String, String)>, ()> {
    if account.is_empty()
        || identity.is_some_and(|identity| {
            identity.owner_account_id != account || identity.requester_account_id != account
        })
    {
        return Err(());
    }
    match shared_session {
        Some(session) => {
            let identity = identity.ok_or(())?;
            if identity.request_id.trim().is_empty() {
                return Err(());
            }
            Ok(Some((session.to_string(), identity.request_id.clone())))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_scope_requires_the_signed_in_owner_and_authenticated_shared_request() {
        let mut identity = RuntimeIdentity {
            request_id: "request".into(),
            agent_id: "agent".into(),
            agent_name: "Agent".into(),
            owner_account_id: "owner".into(),
            owner_name: "Owner".into(),
            requester_account_id: "owner".into(),
            requester_name: "Owner".into(),
            request_policy: None,
        };
        assert_eq!(authorized_scope("owner", None, None), Ok(None));
        assert!(authorized_scope("owner", None, Some("group")).is_err());
        assert_eq!(
            authorized_scope("owner", Some(&identity), Some("group")),
            Ok(Some(("group".into(), "request".into())))
        );
        assert!(authorized_scope("other-account", Some(&identity), None).is_err());
        identity.requester_account_id = "peer".into();
        assert!(authorized_scope("owner", Some(&identity), Some("group")).is_err());
    }
}
