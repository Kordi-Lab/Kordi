use super::*;
use crate::cloud_agent_runtime::provider_auth::ServicePool;
use crate::resource_pools::Feature;

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
            credential: provider_auth.credential(),
            base_url: provider_auth.base_url(),
            model: provider_auth.model(),
            run_id_prefix: None,
            resource_pool: None,
        });
    }
    if let Some(system_agent) = state.system_agent() {
        let config = system_agent.config();
        let pools = config.resource_pools();
        let default_pool = pools.default_pool().id();
        // Each pool hands out its own credentials. A stopped pool hands out
        // none, so its queued runs fail instead of reaching a model.
        for pool in pools.pools().iter().filter(|pool| !pool.is_stopped()) {
            let features = [
                (Feature::SystemAgent, crate::system_agent::RUN_PREFIX),
                // Grounding runs use the same Kordi-operated account.
                (Feature::Grounding, crate::common_ground::RUN_PREFIX),
            ];
            for (feature, prefix) in features {
                if feature == Feature::SystemAgent && !config.group_chat_enabled {
                    continue;
                }
                let provider = pool.provider(feature);
                let provider_auth = provider.auth();
                auths.push(ServiceProviderAuth {
                    owner_account_id: &config.account_id,
                    snapshot_id: provider_auth.snapshot_id(),
                    provider: provider_auth.provider(),
                    auth_choice: provider_auth.auth_choice(),
                    credential: provider_auth.credential(),
                    base_url: provider_auth.base_url(),
                    model: provider_auth.model(),
                    run_id_prefix: Some(prefix),
                    resource_pool: Some(ServicePool {
                        id: pool.id(),
                        is_default: pool.id() == default_pool,
                        headers: provider.headers(),
                    }),
                });
            }
        }
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

    #[tokio::test]
    async fn each_run_gets_the_key_model_and_headers_of_its_pool() {
        let pool = sqlx_postgres::PgPoolOptions::new()
            .connect_lazy("postgres://127.0.0.1:1/test")
            .unwrap();
        let mut config = crate::system_agent::test_config("acct_pool_service");
        config.resource_pools = std::sync::Arc::new(crate::resource_pools::tests::sample_pools(
            Default::default(),
        ));
        let state = ServerState::new(pool, crate::events::EventBus::noop())
            .with_system_agent(crate::system_agent::SystemAgentService::new(config));
        let route = |provider: &str, pool: Option<&str>| {
            let mut route = serde_json::json!({
                "defaultAuthProvider": provider,
                "defaultAuthChoice": "pip-service-api-key",
            });
            if let Some(pool) = pool {
                route["resourcePool"] = serde_json::json!(pool);
            }
            route
        };
        let material = |run_id: &'static str, route: serde_json::Value| {
            let auths = service_provider_auths(&state);
            async move {
                crate::cloud_agent_runtime::provider_auth::service_provider_auth_for_run(
                    "acct_pool_service",
                    run_id,
                    &route,
                    auths,
                )
                .await
                .unwrap()
            }
        };

        let shared = material("pip_1", route("openrouter", Some("shared")))
            .await
            .expect("the default pool's key");
        assert_eq!(shared.provider, "openrouter");
        assert_eq!(shared.payload["apiKey"], "synthetic-shared-key");
        assert_eq!(
            shared.payload["baseUrl"],
            "https://gateway.example.test/api/v1"
        );
        assert_eq!(shared.payload["model"], "vendor/shared-model");
        assert_eq!(
            shared.payload["headers"],
            serde_json::json!({"http-referer": "https://app.example.test", "x-title": "Example"})
        );

        let partner = material("cg_card_1", route("openai", Some("partner")))
            .await
            .expect("the bound pool's Grounding key");
        assert_eq!(partner.payload["model"], "partner-grounding-model");
        assert!(partner.payload.get("headers").is_none());
        let partner_agent = material("pip_2", route("openai", Some("partner")))
            .await
            .unwrap();
        assert_eq!(partner_agent.payload["apiKey"], "synthetic-partner-key");

        // A run queued before pools existed belongs to the default pool.
        let unlabeled = material("pip_3", route("openrouter", None)).await.unwrap();
        assert_eq!(unlabeled.payload["apiKey"], "synthetic-shared-key");
        // Another pool's route never gets the default key, and a stopped pool
        // hands out nothing.
        assert!(material("pip_4", route("openrouter", Some("partner")))
            .await
            .is_none());
        assert!(material("pip_5", route("openai", Some("halted")))
            .await
            .is_none());
        assert!(material("pip_6", route("openai", Some("unknown")))
            .await
            .is_none());
    }
}
