//! Which model and thinking level a digest run asks for (issue 1870).
//!
//! The digest used to run with the owner's latest chat route, so a chat at
//! high effort made every digest run expensive. By default a digest run now
//! asks for a fast model of the same provider with low thinking. The owner
//! can choose the chat's model instead, or name a model. The choice travels
//! on the run's route, whichever executor runs it.

use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// The default thinking level of a digest run.
pub const DIGEST_THINKING: &str = "low";
/// The thinking level of the quick urgency check.
pub const TRIAGE_THINKING: &str = "off";
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high"];

/// The fast model of a provider family, when it has a known one.
pub fn fast_model(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("claude-haiku-4-5"),
        "openai" | "openai-codex" => Some("gpt-5.6-luna"),
        "google" | "google-gemini" => Some("gemini-2.5-flash"),
        _ => None,
    }
}

/// The owner's saved choice.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preference {
    /// "fast" (the default), "chat" (the chat's own model), or a model id.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
}

impl Preference {
    /// A preference with only known values, or an error message.
    pub fn validated(self) -> std::result::Result<Self, &'static str> {
        let model = self
            .model
            .map(|model| model.trim().to_string())
            .filter(|model| !model.is_empty());
        if model
            .as_deref()
            .is_some_and(|model| model.len() > 200 || model.chars().any(char::is_control))
        {
            return Err("Choose a shorter model name.");
        }
        let thinking = self.thinking.filter(|level| !level.is_empty());
        if thinking
            .as_deref()
            .is_some_and(|level| !THINKING_LEVELS.contains(&level))
        {
            return Err("Choose a supported thinking level.");
        }
        Ok(Self { model, thinking })
    }
}

pub async fn preference(pool: &PgPool, account: &str) -> Result<Preference> {
    let row: Option<(Option<Value>,)> =
        query_as("SELECT model_preference FROM cloud_account_digests WHERE account_id=$1")
            .bind(account)
            .fetch_optional(pool)
            .await?;
    Ok(row
        .and_then(|(value,)| value)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default())
}

/// The route a digest run asks for. `thinking` is the default level for
/// this kind of run; a level the owner chose replaces it.
pub fn digest_route(
    mut route: AgentRuntimeRoute,
    preference: &Preference,
    thinking: &str,
) -> AgentRuntimeRoute {
    let provider = route.default_auth_provider.clone().unwrap_or_default();
    match preference.model.as_deref() {
        Some("chat") => return route,
        None | Some("fast") => {
            if let Some(model) = fast_model(&provider) {
                route.default_model = Some(model.to_string());
            }
        }
        Some(model) => route.default_model = Some(model.to_string()),
    }
    route.thinking = Some(
        preference
            .thinking
            .clone()
            .unwrap_or_else(|| thinking.to_string()),
    );
    route
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat(provider: &str) -> AgentRuntimeRoute {
        AgentRuntimeRoute {
            default_model: Some("claude-opus-4-8".into()),
            default_auth_provider: Some(provider.into()),
            default_auth_choice: Some("api-key".into()),
            thinking: Some("xhigh".into()),
        }
    }

    #[test]
    fn digests_default_to_a_fast_model_with_low_thinking() {
        let route = digest_route(chat("anthropic"), &Preference::default(), DIGEST_THINKING);
        assert_eq!(route.default_model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(route.thinking.as_deref(), Some("low"));
        assert_eq!(route.default_auth_provider.as_deref(), Some("anthropic"));
        assert_eq!(route.default_auth_choice.as_deref(), Some("api-key"));
        let codex = digest_route(chat("openai-codex"), &Preference::default(), "off");
        assert_eq!(codex.default_model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(codex.thinking.as_deref(), Some("off"));
        // A provider without a known fast model keeps its model.
        let custom = digest_route(chat("custom"), &Preference::default(), DIGEST_THINKING);
        assert_eq!(custom.default_model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(custom.thinking.as_deref(), Some("low"));
    }

    #[test]
    fn the_owner_can_choose_the_chat_model_or_another_one() {
        let same = Preference {
            model: Some("chat".into()),
            thinking: None,
        };
        assert_eq!(
            digest_route(chat("anthropic"), &same, DIGEST_THINKING),
            chat("anthropic")
        );
        let named = Preference {
            model: Some("claude-sonnet-5".into()),
            thinking: Some("medium".into()),
        };
        let route = digest_route(chat("anthropic"), &named, DIGEST_THINKING);
        assert_eq!(route.default_model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(route.thinking.as_deref(), Some("medium"));
        assert!(Preference {
            model: None,
            thinking: Some("extreme".into())
        }
        .validated()
        .is_err());
    }
}
