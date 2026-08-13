use futures::future::join_all;
use kordi_core::settings::Settings;

use crate::login;

pub(super) async fn fetch_authenticated_provider_model_ids(
    settings: &Settings,
) -> Vec<(String, Option<Vec<String>>)> {
    join_all(
        login::authenticated_providers_for_settings(settings)
            .into_iter()
            .map(|provider| async move {
                let live_ids =
                    super::fetch_live_model_ids_for_provider_with_settings(&provider, settings)
                        .await;
                (provider, live_ids)
            }),
    )
    .await
}
