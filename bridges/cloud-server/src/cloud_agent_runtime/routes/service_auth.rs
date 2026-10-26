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

pub(crate) fn service_provider_auths(state: &ServerState) -> Vec<ServiceProviderAuth<'_>> {
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
    if let Some(system_agent) = state.system_agent() {
        let config = system_agent.config();
        let provider_auth = config.provider_auth();
        if config.group_chat_enabled {
            auths.push(ServiceProviderAuth {
                owner_account_id: &config.account_id,
                snapshot_id: provider_auth.snapshot_id(),
                provider: provider_auth.provider(),
                auth_choice: provider_auth.auth_choice(),
                api_key: provider_auth.api_key(),
                base_url: provider_auth.base_url(),
                model: provider_auth.model(),
                run_id_prefix: Some(crate::system_agent::RUN_PREFIX),
            });
        }
        // Common ground runs use the same Kordi-operated key.
        auths.push(ServiceProviderAuth {
            owner_account_id: &config.account_id,
            snapshot_id: provider_auth.snapshot_id(),
            provider: provider_auth.provider(),
            auth_choice: provider_auth.auth_choice(),
            api_key: provider_auth.api_key(),
            base_url: provider_auth.base_url(),
            model: provider_auth.model(),
            run_id_prefix: Some(crate::common_ground::RUN_PREFIX),
        });
    }
    auths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn grounding_only_service_does_not_authorize_or_start_group_chat_runs() {
        let pool = sqlx_postgres::PgPoolOptions::new()
            .connect_lazy("postgres://127.0.0.1:1/test")
            .unwrap();
        let mut config = crate::system_agent::test_config("acct_grounding_only");
        config.group_chat_enabled = false;
        let state = std::sync::Arc::new(
            ServerState::new(pool, crate::events::EventBus::noop())
                .with_system_agent(crate::system_agent::SystemAgentService::new(config)),
        );
        assert!(crate::common_ground::available(&state));
        let auths = service_provider_auths(&state);
        assert_eq!(auths.len(), 1);
        assert!(auths[0].covers_run("cg_card_synthetic"));
        assert!(!auths[0].covers_run("pip_synthetic"));
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            crate::system_agent::spawn(state),
        )
        .await
        .expect("group worker must exit without querying any chat")
        .unwrap();
    }
}
