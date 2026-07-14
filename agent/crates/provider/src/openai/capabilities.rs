use kordi_core::agent_session::ThinkingLevel;

const STANDARD_LEVELS: [ThinkingLevel; 5] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const XHIGH_LEVELS: [ThinkingLevel; 6] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
];
const API_GPT_55_LEVELS: [ThinkingLevel; 5] = [
    ThinkingLevel::Off,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
];
const MAX_LEVELS: [ThinkingLevel; 7] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
    ThinkingLevel::Max,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenAiAuthRoute {
    Api,
    CodexOAuth,
}

fn normalized_model_id(model_id: &str) -> String {
    model_id
        .rsplit_once('/')
        .map_or(model_id, |(_, id)| id)
        .trim()
        .to_ascii_lowercase()
}

fn is_gpt_56_variant(model_id: &str) -> bool {
    matches!(model_id, "gpt-5.6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra")
}

pub fn thinking_levels(model_id: &str, route: OpenAiAuthRoute) -> &'static [ThinkingLevel] {
    let model_id = normalized_model_id(model_id);
    if is_gpt_56_variant(&model_id) {
        return &MAX_LEVELS;
    }

    if route == OpenAiAuthRoute::Api && model_id == "gpt-5.5" {
        return &API_GPT_55_LEVELS;
    }

    if route == OpenAiAuthRoute::CodexOAuth
        && matches!(
            model_id.as_str(),
            "gpt-5.3-codex-spark" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.5"
        )
    {
        return &XHIGH_LEVELS;
    }

    if ["gpt-5.2", "gpt-5.3", "gpt-5.4"]
        .iter()
        .any(|family| model_id.starts_with(family))
    {
        &XHIGH_LEVELS
    } else {
        &STANDARD_LEVELS
    }
}

pub fn clamp_thinking_level(
    model_id: &str,
    route: OpenAiAuthRoute,
    requested: ThinkingLevel,
) -> ThinkingLevel {
    if requested == ThinkingLevel::Default {
        return requested;
    }

    let levels = thinking_levels(model_id, route);
    if levels.contains(&requested) {
        return requested;
    }

    match requested {
        ThinkingLevel::Max if levels.contains(&ThinkingLevel::XHigh) => ThinkingLevel::XHigh,
        ThinkingLevel::Max | ThinkingLevel::XHigh if levels.contains(&ThinkingLevel::High) => {
            ThinkingLevel::High
        }
        ThinkingLevel::Minimal if levels.contains(&ThinkingLevel::Low) => ThinkingLevel::Low,
        _ if levels.contains(&ThinkingLevel::Off) => ThinkingLevel::Off,
        _ => levels.first().copied().unwrap_or(ThinkingLevel::Off),
    }
}

pub fn reasoning_effort(
    model_id: &str,
    route: OpenAiAuthRoute,
    thinking: &str,
) -> Option<&'static str> {
    let requested = ThinkingLevel::parse(thinking).unwrap_or(ThinkingLevel::Medium);
    let effective = clamp_thinking_level(model_id, route, requested);
    match effective {
        ThinkingLevel::Default => None,
        ThinkingLevel::Off => Some("none"),
        ThinkingLevel::Minimal if route == OpenAiAuthRoute::CodexOAuth => Some("low"),
        ThinkingLevel::Minimal => Some("minimal"),
        ThinkingLevel::Low => Some("low"),
        ThinkingLevel::Medium => Some("medium"),
        ThinkingLevel::High => Some("high"),
        ThinkingLevel::XHigh => Some("xhigh"),
        ThinkingLevel::Max => Some("max"),
    }
}

#[cfg(test)]
mod tests {
    use super::{OpenAiAuthRoute, clamp_thinking_level, reasoning_effort, thinking_levels};
    use kordi_core::agent_session::ThinkingLevel;

    #[test]
    fn gpt_56_variants_support_every_thinking_level_on_both_routes() {
        let expected = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        for model in ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] {
            for route in [OpenAiAuthRoute::Api, OpenAiAuthRoute::CodexOAuth] {
                assert_eq!(
                    thinking_levels(model, route)
                        .iter()
                        .map(|level| level.as_str())
                        .collect::<Vec<_>>(),
                    expected
                );
            }
        }
    }

    #[test]
    fn gpt_55_minimal_is_oauth_only() {
        assert!(
            !thinking_levels("gpt-5.5", OpenAiAuthRoute::Api).contains(&ThinkingLevel::Minimal)
        );
        assert!(
            thinking_levels("gpt-5.5", OpenAiAuthRoute::CodexOAuth)
                .contains(&ThinkingLevel::Minimal)
        );
    }

    #[test]
    fn unsupported_high_end_levels_clamp_downward() {
        assert_eq!(
            clamp_thinking_level("gpt-5.5", OpenAiAuthRoute::Api, ThinkingLevel::Max),
            ThinkingLevel::XHigh
        );
        assert_eq!(
            clamp_thinking_level("gpt-4.1", OpenAiAuthRoute::Api, ThinkingLevel::Max),
            ThinkingLevel::High
        );
    }

    #[test]
    fn reasoning_effort_is_route_and_model_aware() {
        assert_eq!(
            reasoning_effort("gpt-5.6-luna", OpenAiAuthRoute::Api, "default"),
            None
        );
        assert_eq!(
            reasoning_effort("gpt-5.6-luna", OpenAiAuthRoute::Api, "off"),
            Some("none")
        );
        assert_eq!(
            reasoning_effort("gpt-5.6-luna", OpenAiAuthRoute::Api, "minimal"),
            Some("minimal")
        );
        assert_eq!(
            reasoning_effort("gpt-5.6-luna", OpenAiAuthRoute::CodexOAuth, "minimal"),
            Some("low")
        );
        assert_eq!(
            reasoning_effort("gpt-5.6-luna", OpenAiAuthRoute::Api, "xhigh"),
            Some("xhigh")
        );
        assert_eq!(
            reasoning_effort("gpt-5.6-luna", OpenAiAuthRoute::CodexOAuth, "max"),
            Some("max")
        );
    }
}
