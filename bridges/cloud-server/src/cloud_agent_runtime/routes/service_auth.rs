use super::*;

pub(super) fn include_service_provider_auth(state: &ServerState, run: &mut RunnerRunResponse) {
    if run.provider_auth_available {
        return;
    }
    run.provider_auth_available = service_provider_auths(state).iter().any(|service_auth| {
        run.owner_account_id == service_auth.owner_account_id
            && service_auth.covers_run(&run.run_id)
            && run.runtime_route.default_auth_provider.as_deref() == Some(service_auth.provider)
            && run.runtime_route.default_auth_choice.as_deref() == Some(service_auth.auth_choice)
    });
}

pub(super) fn service_provider_auths(state: &ServerState) -> Vec<ServiceProviderAuth<'_>> {
    let mut auths = Vec::new();
    if let Some(support) = state.support() {
        let config = support.config();
        let provider_auth = config.provider_auth();
        auths.push(ServiceProviderAuth {
            owner_account_id: &config.owner_account_id,
            snapshot_id: provider_auth.snapshot_id(),
            provider: provider_auth.provider(),
            auth_choice: provider_auth.auth_choice(),
            api_key: provider_auth.api_key(),
            base_url: provider_auth.base_url(),
            model: provider_auth.model(),
            run_id_prefix: None,
        });
    }
    if let Some(pip) = state.pip() {
        let config = pip.config();
        let provider_auth = config.provider_auth();
        auths.push(ServiceProviderAuth {
            owner_account_id: &config.account_id,
            snapshot_id: provider_auth.snapshot_id(),
            provider: provider_auth.provider(),
            auth_choice: provider_auth.auth_choice(),
            api_key: provider_auth.api_key(),
            base_url: provider_auth.base_url(),
            model: provider_auth.model(),
            run_id_prefix: Some(crate::pip::RUN_PREFIX),
        });
    }
    auths
}
