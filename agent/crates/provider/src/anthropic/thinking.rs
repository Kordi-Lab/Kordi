//! The thinking and effort fields of a Messages request.

use kordi_core::agent_session::ThinkingLevel;
use serde_json::{Value, json};

use super::capabilities::{ThinkingPlan, thinking_plan};

/// Visible output a budget-thinking request keeps after its thinking budget.
const BUDGET_OUTPUT_BUFFER: u32 = 4_096;
/// OMP's `OUTPUT_FALLBACK_BUFFER`: a budget leaves this much of the model's
/// output ceiling for the reply.
const OUTPUT_CEILING_BUFFER: u32 = 4_000;

/// Adds the thinking and effort fields `thinking` asks for on `model`.
///
/// No value and `default` send none. An unrecognized value runs at Medium.
pub(super) fn apply_thinking(
    body: &mut Value,
    model: &str,
    thinking: Option<&str>,
    max_tokens: u32,
) {
    let Some(thinking) = thinking else {
        return;
    };
    let requested = ThinkingLevel::parse(thinking).unwrap_or(ThinkingLevel::Medium);
    match thinking_plan(model, requested) {
        ThinkingPlan::Omit => {}
        ThinkingPlan::Disabled => body["thinking"] = json!({ "type": "disabled" }),
        ThinkingPlan::BetweenTools => body["thinking"] = json!({ "type": "between_tools" }),
        ThinkingPlan::EffortOnly(effort) => body["output_config"] = json!({ "effort": effort }),
        ThinkingPlan::Adaptive { effort, display } => {
            body["thinking"] = thinking_block(json!({ "type": "adaptive" }), display);
            body["output_config"] = json!({ "effort": effort });
        }
        ThinkingPlan::Budget {
            budget_tokens,
            output_limit,
            display,
            effort,
        } => {
            let limit = output_limit.unwrap_or(u32::MAX);
            let budget_tokens = budget_tokens.min(limit.saturating_sub(OUTPUT_CEILING_BUFFER));
            body["thinking"] = thinking_block(
                json!({ "type": "enabled", "budget_tokens": budget_tokens }),
                display,
            );
            if max_tokens < budget_tokens + BUDGET_OUTPUT_BUFFER {
                body["max_tokens"] = json!((budget_tokens + BUDGET_OUTPUT_BUFFER).min(limit));
            }
            if let Some(effort) = effort {
                body["output_config"] = json!({ "effort": effort });
            }
        }
    }
}

fn thinking_block(mut block: Value, display: bool) -> Value {
    if display {
        block["display"] = json!("summarized");
    }
    block
}

#[cfg(test)]
mod tests;
