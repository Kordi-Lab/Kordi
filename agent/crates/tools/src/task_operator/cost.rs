use kordi_provider::registry::Model;

pub fn estimate_cost_microunits(model: &Model, input_tokens: u64, output_tokens: u64) -> u64 {
    let input = model.cost.input * input_tokens as f64;
    let output = model.cost.output * output_tokens as f64;
    (input + output).round().max(0.0) as u64
}

#[cfg(test)]
mod tests {
    use super::estimate_cost_microunits;
    use kordi_provider::registry::{ApiType, CostConfig, Model, ModelInput};

    fn model() -> Model {
        Model {
            id: "demo".to_string(),
            name: "Demo".to_string(),
            provider: "test".to_string(),
            api: ApiType::OpenaiCompletions,
            context_window: 100_000,
            max_tokens: 10_000,
            reasoning: false,
            input: vec![ModelInput::Text],
            base_url: None,
            cost: CostConfig {
                input: 2.0,
                output: 8.0,
                cache_read: 0.0,
                cache_write: 0.0,
            },
        }
    }

    #[test]
    fn estimates_cost_microunits_from_per_million_rates() {
        let cost = estimate_cost_microunits(&model(), 1_000, 500);
        assert_eq!(cost, 6_000);
    }
}
