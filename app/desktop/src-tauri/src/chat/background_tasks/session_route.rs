//! The route a background session runs with when a turn names none.
//!
//! A background session inherits the parent turn's route: the same model and
//! the same account. Later turns, such as an owner's follow-up claimed from
//! Kordi Cloud, start without a route of their own and run on this one.

use kordi_cli::desktop_runtime::{
    background_session_turn_route, set_background_session_turn_route, DesktopRuntimeTurnRoute,
};

use super::super::DesktopChatMessageRoute;

pub(in crate::chat) fn turn_route_from_message_route(
    route: &DesktopChatMessageRoute,
) -> DesktopRuntimeTurnRoute {
    DesktopRuntimeTurnRoute {
        model: route.model.clone(),
        auth_provider: route.auth_provider.clone(),
        auth_choice: route.auth_choice.clone(),
        thinking: route.thinking.clone(),
    }
}

fn message_route_from_turn_route(route: DesktopRuntimeTurnRoute) -> DesktopChatMessageRoute {
    DesktopChatMessageRoute {
        model: route.model,
        auth_provider: route.auth_provider,
        auth_choice: route.auth_choice,
        thinking: route.thinking,
    }
}

/// The route for a turn: the one it names, or else its background session's.
pub(in crate::chat) fn route_for_turn(
    session_id: &str,
    route: Option<DesktopChatMessageRoute>,
) -> Option<DesktopChatMessageRoute> {
    route.or_else(|| {
        background_session_turn_route(session_id)
            .ok()
            .flatten()
            .map(message_route_from_turn_route)
    })
}

/// Reads a background session's route, or records the model the owner
/// picked for it when `model` is given.
#[tauri::command]
pub async fn desktop_chat_background_session_route(
    session_id: String,
    model: Option<String>,
    thinking: Option<String>,
) -> Result<Option<DesktopRuntimeTurnRoute>, String> {
    let result = match model {
        Some(model) => set_background_session_turn_route(
            &session_id,
            DesktopRuntimeTurnRoute {
                model: Some(model),
                thinking,
                ..DesktopRuntimeTurnRoute::default()
            },
        )
        .map(Some),
        None => background_session_turn_route(&session_id),
    };
    result.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_cli::desktop_runtime::{
        create_background_session, DesktopRuntimeProfile, DesktopRuntimeSession,
    };

    struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvGuard {
        fn set(values: &[(&'static str, std::ffi::OsString)]) -> Self {
            Self(
                values
                    .iter()
                    .map(|(key, value)| {
                        let previous = std::env::var_os(key);
                        std::env::set_var(key, value);
                        (*key, previous)
                    })
                    .collect(),
            )
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, previous) in &self.0 {
                match previous {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn hosted_codex_route() -> DesktopChatMessageRoute {
        DesktopChatMessageRoute {
            model: Some("openai-codex/gpt-6-sol".into()),
            auth_provider: Some("openai-codex".into()),
            auth_choice: Some("cloud-login:synthetic".into()),
            thinking: Some("high".into()),
        }
    }

    /// A turn claimed for a background session names no route. It must run
    /// on the parent turn's ChatGPT account, not on the `openai` model
    /// namespace the saved profile names.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_later_background_turn_runs_on_the_parent_route() {
        let storage = crate::test_support::ScopedKordiStorageRoot::new("background-route");
        let root = storage.root().to_path_buf();
        let (home, app, cwd) = (root.join("home"), root.join("app"), root.join("cwd"));
        for dir in [&home, &app, &cwd] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let _env = EnvGuard::set(&[
            ("HOME", home.into_os_string()),
            ("APP_DATA_DIR", app.into_os_string()),
            ("VITE_KORDI_CLOUD_API_BASE", "http://127.0.0.1:9".into()),
            ("VITE_KORDI_DEV_PROFILE", "community".into()),
        ]);
        let child =
            create_background_session(&cwd, "session:group:synthetic", Some("msg"), "Investigate")
                .unwrap();
        let profile = DesktopRuntimeProfile {
            provider: Some("openai".into()),
            model: Some("gpt-6-sol".into()),
            turn_route: Some(turn_route_from_message_route(&hosted_codex_route())),
            ..DesktopRuntimeProfile::default()
        };
        DesktopRuntimeSession::resume_profiled(cwd.clone(), &child, profile)
            .await
            .unwrap();
        kordi_cli::desktop_runtime::activate_background_runtime_session(&child).unwrap();

        let route = route_for_turn(&child, None).expect("inherited route");
        assert_eq!(route.model, hosted_codex_route().model);
        assert_eq!(route.auth_provider.as_deref(), Some("openai-codex"));
        assert_eq!(route.auth_choice.as_deref(), Some("cloud-login:synthetic"));

        // A route the turn names still wins.
        let named = DesktopChatMessageRoute {
            model: Some("openai-codex/gpt-6-mini".into()),
            ..DesktopChatMessageRoute::default()
        };
        assert_eq!(
            route_for_turn(&child, Some(named)).and_then(|route| route.model),
            Some("openai-codex/gpt-6-mini".into())
        );

        // The owner's model choice keeps the account.
        let picked = desktop_chat_background_session_route(
            child.clone(),
            Some("openai-codex/gpt-6-mini".into()),
            None,
        )
        .await
        .unwrap()
        .expect("saved route");
        assert_eq!(picked.auth_choice.as_deref(), Some("cloud-login:synthetic"));
        assert_eq!(
            route_for_turn(&child, None).and_then(|route| route.model),
            Some("openai-codex/gpt-6-mini".into())
        );

        // Ordinary sessions keep their own settings.
        assert!(route_for_turn("not-a-background-session", None).is_none());
    }
}
