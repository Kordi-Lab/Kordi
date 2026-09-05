use super::{ReasoningCapability, cost, model, runtime, simple_cost};
use crate::registry::{ApiType, Model};

pub(super) fn builtin_models() -> Vec<Model> {
    vec![
        model(
            "gpt-5.6-luna",
            "GPT-5.6 Luna",
            "openai",
            ApiType::OpenaiResponses,
            (272_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            cost(1.0, 6.0, 0.1, 1.25),
        ),
        model(
            "gpt-5.6-sol",
            "GPT-5.6 Sol",
            "openai",
            ApiType::OpenaiResponses,
            (272_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            cost(5.0, 30.0, 0.5, 6.25),
        ),
        model(
            "gpt-5.6-terra",
            "GPT-5.6 Terra",
            "openai",
            ApiType::OpenaiResponses,
            (272_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            cost(2.5, 15.0, 0.25, 3.125),
        ),
        model(
            "gpt-6-astra",
            "GPT-6 Astra",
            "openai",
            ApiType::OpenaiResponses,
            (1_050_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            cost(10.0, 50.0, 1.0, 12.5),
        ),
        model(
            "gpt-5.5",
            "GPT-5.5",
            "openai",
            ApiType::OpenaiResponses,
            (272_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(5.0, 30.0),
        ),
        model(
            "gpt-5.4",
            "GPT-5.4",
            "openai",
            ApiType::OpenaiResponses,
            (272_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(2.5, 10.0),
        ),
        model(
            "gpt-5.2",
            "GPT-5.2",
            "openai",
            ApiType::OpenaiResponses,
            (400_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(2.0, 8.0),
        ),
        model(
            "gpt-5.1-codex",
            "GPT-5.1 Codex",
            "openai",
            ApiType::OpenaiResponses,
            (400_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(2.0, 8.0),
        ),
        model(
            "gpt-5",
            "GPT-5",
            "openai",
            ApiType::OpenaiResponses,
            (400_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(2.0, 8.0),
        ),
        model(
            "gpt-5-mini",
            "GPT-5 Mini",
            "openai",
            ApiType::OpenaiResponses,
            (400_000, 128_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(0.3, 1.2),
        ),
        model(
            "gpt-4o",
            "GPT-4o",
            "openai",
            ApiType::OpenaiCompletions,
            (128_000, 16_384),
            runtime(
                ReasoningCapability::Unsupported,
                "https://api.openai.com/v1",
            ),
            simple_cost(2.5, 10.0),
        ),
        model(
            "gpt-4o-mini",
            "GPT-4o Mini",
            "openai",
            ApiType::OpenaiCompletions,
            (128_000, 16_384),
            runtime(
                ReasoningCapability::Unsupported,
                "https://api.openai.com/v1",
            ),
            simple_cost(0.15, 0.6),
        ),
        model(
            "o3",
            "o3",
            "openai",
            ApiType::OpenaiCompletions,
            (200_000, 100_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(2.0, 8.0),
        ),
        model(
            "o3-mini",
            "o3-mini",
            "openai",
            ApiType::OpenaiCompletions,
            (200_000, 100_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(1.1, 4.4),
        ),
        model(
            "o4-mini",
            "o4-mini",
            "openai",
            ApiType::OpenaiCompletions,
            (200_000, 100_000),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(1.1, 4.4),
        ),
        model(
            "gpt-4-turbo",
            "GPT-4 Turbo",
            "openai",
            ApiType::OpenaiCompletions,
            (128_000, 4_096),
            runtime(
                ReasoningCapability::Unsupported,
                "https://api.openai.com/v1",
            ),
            simple_cost(10.0, 30.0),
        ),
        model(
            "o1-mini",
            "o1-mini",
            "openai",
            ApiType::OpenaiCompletions,
            (128_000, 65_536),
            runtime(ReasoningCapability::Supported, "https://api.openai.com/v1"),
            simple_cost(3.0, 12.0),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::builtin_models;

    #[test]
    fn gpt_6_has_its_own_limits_and_standard_short_context_prices() {
        let models = builtin_models();
        let model = models
            .iter()
            .find(|model| model.id == "gpt-6-astra")
            .unwrap();
        assert_eq!(model.context_window, 1_050_000);
        assert_eq!(model.max_tokens, 128_000);
        assert!(model.reasoning);
        assert!(matches!(model.api, super::ApiType::OpenaiResponses));
        assert_eq!(model.cost.input, 10.0);
        assert_eq!(model.cost.output, 50.0);
    }

    #[test]
    fn registry_contains_only_named_gpt_56_variants() {
        let models = builtin_models();
        for id in ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] {
            let model = models
                .iter()
                .find(|model| model.id == id)
                .expect("GPT-5.6 variant");
            assert_eq!(model.context_window, 272_000);
            assert_eq!(model.max_tokens, 128_000);
            assert!(model.reasoning);
        }
        assert!(models.iter().all(|model| model.id != "gpt-5.6"));
    }
}
