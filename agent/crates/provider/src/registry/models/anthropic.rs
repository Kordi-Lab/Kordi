use super::{ReasoningCapability, cost, model, runtime};
use crate::registry::{ApiType, Model};

pub(super) fn builtin_models() -> Vec<Model> {
    vec![
        model(
            "claude-fable-5",
            "Claude Fable 5",
            "anthropic",
            ApiType::AnthropicMessages,
            (1_000_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(10.0, 50.0, 1.0, 12.5),
        ),
        model(
            "claude-haiku-4-5",
            "Claude Haiku 4.5 (latest)",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 64_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(1.0, 5.0, 0.1, 1.25),
        ),
        model(
            "claude-haiku-4-5-20251001",
            "Claude Haiku 4.5",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 64_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(1.0, 5.0, 0.1, 1.25),
        ),
        model(
            "claude-opus-4-1",
            "Claude Opus 4.1 (latest)",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 32_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(15.0, 75.0, 1.5, 18.75),
        ),
        model(
            "claude-opus-4-1-20250805",
            "Claude Opus 4.1",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 32_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(15.0, 75.0, 1.5, 18.75),
        ),
        model(
            "claude-opus-4-5",
            "Claude Opus 4.5 (latest)",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 64_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(5.0, 25.0, 0.5, 6.25),
        ),
        model(
            "claude-opus-4-5-20251101",
            "Claude Opus 4.5",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 64_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(5.0, 25.0, 0.5, 6.25),
        ),
        model(
            "claude-opus-4-6",
            "Claude Opus 4.6",
            "anthropic",
            ApiType::AnthropicMessages,
            (1_000_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(5.0, 25.0, 0.5, 6.25),
        ),
        model(
            "claude-opus-4-7",
            "Claude Opus 4.7",
            "anthropic",
            ApiType::AnthropicMessages,
            (1_000_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(5.0, 25.0, 0.5, 6.25),
        ),
        model(
            "claude-opus-4-8",
            "Claude Opus 4.8",
            "anthropic",
            ApiType::AnthropicMessages,
            (1_000_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(5.0, 25.0, 0.5, 6.25),
        ),
        model(
            "claude-sonnet-4-5",
            "Claude Sonnet 4.5 (latest)",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 64_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(3.0, 15.0, 0.3, 3.75),
        ),
        model(
            "claude-sonnet-4-5-20250929",
            "Claude Sonnet 4.5",
            "anthropic",
            ApiType::AnthropicMessages,
            (200_000, 64_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(3.0, 15.0, 0.3, 3.75),
        ),
        model(
            "claude-sonnet-4-6",
            "Claude Sonnet 4.6",
            "anthropic",
            ApiType::AnthropicMessages,
            (1_000_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(3.0, 15.0, 0.3, 3.75),
        ),
        model(
            "claude-sonnet-5",
            "Claude Sonnet 5",
            "anthropic",
            ApiType::AnthropicMessages,
            (1_000_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.anthropic.com"),
            cost(2.0, 10.0, 0.2, 2.5),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::builtin_models;
    use crate::anthropic::capabilities::{
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS, DEFAULT_ANTHROPIC_MODEL_ID,
    };
    use crate::registry::{ApiType, ModelInput};

    #[test]
    fn builtin_catalog_matches_the_supported_claude_contract() {
        let models = builtin_models();
        let ids = models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, ANTHROPIC_SUBSCRIPTION_MODEL_IDS);
        assert!(ids.contains(&DEFAULT_ANTHROPIC_MODEL_ID));
    }

    #[test]
    fn builtin_catalog_has_exact_names_limits_and_costs() {
        struct ExpectedModel {
            id: &'static str,
            name: &'static str,
            context_window: u64,
            max_tokens: u64,
            costs: (f64, f64, f64, f64),
        }

        let expected = [
            ExpectedModel {
                id: "claude-fable-5",
                name: "Claude Fable 5",
                context_window: 1_000_000,
                max_tokens: 128_000,
                costs: (10.0, 50.0, 1.0, 12.5),
            },
            ExpectedModel {
                id: "claude-haiku-4-5",
                name: "Claude Haiku 4.5 (latest)",
                context_window: 200_000,
                max_tokens: 64_000,
                costs: (1.0, 5.0, 0.1, 1.25),
            },
            ExpectedModel {
                id: "claude-haiku-4-5-20251001",
                name: "Claude Haiku 4.5",
                context_window: 200_000,
                max_tokens: 64_000,
                costs: (1.0, 5.0, 0.1, 1.25),
            },
            ExpectedModel {
                id: "claude-opus-4-1",
                name: "Claude Opus 4.1 (latest)",
                context_window: 200_000,
                max_tokens: 32_000,
                costs: (15.0, 75.0, 1.5, 18.75),
            },
            ExpectedModel {
                id: "claude-opus-4-1-20250805",
                name: "Claude Opus 4.1",
                context_window: 200_000,
                max_tokens: 32_000,
                costs: (15.0, 75.0, 1.5, 18.75),
            },
            ExpectedModel {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5 (latest)",
                context_window: 200_000,
                max_tokens: 64_000,
                costs: (5.0, 25.0, 0.5, 6.25),
            },
            ExpectedModel {
                id: "claude-opus-4-5-20251101",
                name: "Claude Opus 4.5",
                context_window: 200_000,
                max_tokens: 64_000,
                costs: (5.0, 25.0, 0.5, 6.25),
            },
            ExpectedModel {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                context_window: 1_000_000,
                max_tokens: 128_000,
                costs: (5.0, 25.0, 0.5, 6.25),
            },
            ExpectedModel {
                id: "claude-opus-4-7",
                name: "Claude Opus 4.7",
                context_window: 1_000_000,
                max_tokens: 128_000,
                costs: (5.0, 25.0, 0.5, 6.25),
            },
            ExpectedModel {
                id: "claude-opus-4-8",
                name: "Claude Opus 4.8",
                context_window: 1_000_000,
                max_tokens: 128_000,
                costs: (5.0, 25.0, 0.5, 6.25),
            },
            ExpectedModel {
                id: "claude-sonnet-4-5",
                name: "Claude Sonnet 4.5 (latest)",
                context_window: 200_000,
                max_tokens: 64_000,
                costs: (3.0, 15.0, 0.3, 3.75),
            },
            ExpectedModel {
                id: "claude-sonnet-4-5-20250929",
                name: "Claude Sonnet 4.5",
                context_window: 200_000,
                max_tokens: 64_000,
                costs: (3.0, 15.0, 0.3, 3.75),
            },
            ExpectedModel {
                id: "claude-sonnet-4-6",
                name: "Claude Sonnet 4.6",
                context_window: 1_000_000,
                max_tokens: 128_000,
                costs: (3.0, 15.0, 0.3, 3.75),
            },
            ExpectedModel {
                id: "claude-sonnet-5",
                name: "Claude Sonnet 5",
                context_window: 1_000_000,
                max_tokens: 128_000,
                costs: (2.0, 10.0, 0.2, 2.5),
            },
        ];

        let models = builtin_models();
        assert_eq!(models.len(), expected.len());
        for (model, expected) in models.iter().zip(expected) {
            assert_eq!(model.id, expected.id);
            assert_eq!(model.name, expected.name, "{}", expected.id);
            assert_eq!(
                (model.context_window, model.max_tokens),
                (expected.context_window, expected.max_tokens),
                "{}",
                expected.id
            );
            assert_eq!(
                (
                    model.cost.input,
                    model.cost.output,
                    model.cost.cache_read,
                    model.cost.cache_write,
                ),
                expected.costs,
                "{}",
                expected.id
            );
        }
    }

    #[test]
    fn builtin_catalog_uses_the_anthropic_runtime_contract() {
        for model in builtin_models() {
            assert_eq!(model.provider, "anthropic", "{}", model.id);
            assert!(
                matches!(&model.api, ApiType::AnthropicMessages),
                "{}",
                model.id
            );
            assert!(model.reasoning, "{}", model.id);
            assert_eq!(
                model.input,
                vec![ModelInput::Text, ModelInput::Image],
                "{}",
                model.id
            );
            assert_eq!(
                model.base_url.as_deref(),
                Some("https://api.anthropic.com"),
                "{}",
                model.id
            );
        }
    }
}
