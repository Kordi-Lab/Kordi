use kordi_core::agent_session::ThinkingLevel;

// Claude thinking and effort follow OMP (oh-my-pi 18.12.6): the per-model
// `thinking` and `compat` rows in pi-catalog `models.json`, the request
// building in pi-ai `providers/anthropic.ts`, and the clamping and effort
// mapping in pi-catalog `model-thinking.ts`. Kordi differs from OMP on purpose
// where the Claude API reference says OMP's request would fail or would not do
// what the setting means:
//
// 1. Off on Opus 4.6, 4.7 and 4.8, Sonnet 4.6, Sonnet 5 and Opus 5 sends
//    `{type: "disabled"}`. OMP leaves thinking out and pins effort low, which
//    keeps adaptive thinking on for Sonnet 5 and Opus 5. The API accepts
//    disabled on all six (Opus 5 at effort high or below, and Off sends no
//    effort), and digest triage relies on a real off.
// 2. Off on Fable 5 and 5.1 follows OMP: no thinking field and effort low,
//    because the API rejects disabled thinking on Fable.
// 3. Default sends no thinking or effort field. OMP's session default turns
//    it into high effort; the cloud runner gives Sonnet 5.5 Medium instead.
// 4. Opus 4.5 caps `output_config.effort` at high. OMP sends xhigh at xhigh
//    and max, which the API rejects (Opus 4.5 takes low, medium and high).
// 5. `claude-opus-4-1-20250805` is a budget-thinking model like
//    `claude-opus-4-1`. OMP's catalog marks the dated ID as non-reasoning.
// 6. Sonnet 4.6 keeps max effort, as the API lists low, medium, high and max
//    for it. OMP's catalog lists low to high, so it sends high at max.

/// Effort levels in increasing order, as OMP clamps them.
const EFFORT_ORDER: &[ThinkingLevel] = &[
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
    ThinkingLevel::Max,
];
const BUDGET_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
];
const ADAPTIVE_4_6_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Max,
];
const ADAPTIVE_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
    ThinkingLevel::Max,
];
/// Models whose thinking cannot be turned off hide Off; a stored Off still applies.
const ALWAYS_ON_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
    ThinkingLevel::Max,
];
/// Unknown Claude IDs keep conservative budget thinking up to High.
const UNKNOWN_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];

/// The request-side thinking mechanism supported by a Claude model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeThinkingMode {
    /// Uses Anthropic's adaptive thinking configuration and effort values.
    Adaptive,
    /// Uses an explicit thinking-token budget.
    Budget,
}

/// How an explicit stored [`ThinkingLevel::Off`] is represented in a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingOffBehavior {
    /// Send `{type: "disabled"}`.
    Disabled,
    /// Send `{type: "between_tools"}` with no other thinking field and no effort:
    /// Claude Sonnet 5.5 rejects disabled thinking.
    BetweenTools,
    /// Leave thinking out and send effort low: Claude Fable 5, Claude Fable 5.1 and
    /// Claude Opus 5.5 cannot turn thinking off.
    LowEffort,
}

/// Request capabilities derived from a known Claude model's profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaudeModelCapabilities {
    /// Whether the model uses adaptive or budget thinking.
    pub thinking_mode: ClaudeThinkingMode,
    /// Whether the model exposes native extra-high adaptive effort.
    pub native_xhigh: bool,
    /// Whether the model exposes maximum adaptive effort.
    pub supports_max: bool,
    /// Whether requests for this model may include temperature.
    pub supports_temperature: bool,
    /// How request construction should represent explicit thinking-off state.
    pub thinking_off: ThinkingOffBehavior,
    /// Whether thinking requests ask for summarized thinking text (`display`).
    pub supports_display: bool,
}

/// The thinking and effort fields one request sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingPlan {
    /// No thinking or effort field.
    Omit,
    /// `thinking: {type: "disabled"}` and no effort.
    Disabled,
    /// `thinking: {type: "between_tools"}` alone. It carries no effort, so it never
    /// meets the xhigh or max effort that the API rejects with it.
    BetweenTools,
    /// No thinking field; `output_config.effort` only.
    EffortOnly(&'static str),
    /// Adaptive thinking at an effort.
    Adaptive { effort: &'static str, display: bool },
    /// Budget thinking, with an effort on models that take one.
    Budget {
        budget_tokens: u32,
        /// The model's output-token ceiling; the budget and `max_tokens` fit under it.
        output_limit: Option<u32>,
        display: bool,
        effort: Option<&'static str>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BudgetProfile {
    output_limit: Option<u32>,
    /// Budget models that also take `output_config.effort`, capped at this level.
    effort_ceiling: Option<ThinkingLevel>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ClaudeModelProfile {
    /// Exposed levels: Off (when shown) and OMP's efforts, lowest first.
    levels: &'static [ThinkingLevel],
    /// `None` for adaptive thinking.
    budget: Option<BudgetProfile>,
    display: bool,
    off: ThinkingOffBehavior,
    temperature: bool,
}

const fn budget(output_limit: u32, effort_ceiling: Option<ThinkingLevel>) -> ClaudeModelProfile {
    ClaudeModelProfile {
        levels: BUDGET_LEVELS,
        budget: Some(BudgetProfile {
            output_limit: Some(output_limit),
            effort_ceiling,
        }),
        display: true,
        off: ThinkingOffBehavior::Disabled,
        temperature: true,
    }
}

const fn adaptive(
    levels: &'static [ThinkingLevel],
    display: bool,
    off: ThinkingOffBehavior,
    temperature: bool,
) -> ClaudeModelProfile {
    ClaudeModelProfile {
        levels,
        budget: None,
        display,
        off,
        temperature,
    }
}

const BUDGET: ClaudeModelProfile = budget(64_000, None);
const BUDGET_32K: ClaudeModelProfile = budget(32_000, None);
const BUDGET_WITH_EFFORT: ClaudeModelProfile = budget(64_000, Some(ThinkingLevel::High));
const ADAPTIVE_4_6: ClaudeModelProfile = adaptive(
    ADAPTIVE_4_6_LEVELS,
    false,
    ThinkingOffBehavior::Disabled,
    true,
);
const ADAPTIVE: ClaudeModelProfile =
    adaptive(ADAPTIVE_LEVELS, true, ThinkingOffBehavior::Disabled, false);
const BETWEEN_TOOLS: ClaudeModelProfile = adaptive(
    ADAPTIVE_LEVELS,
    true,
    ThinkingOffBehavior::BetweenTools,
    false,
);
const ALWAYS_ON: ClaudeModelProfile = adaptive(
    ALWAYS_ON_LEVELS,
    true,
    ThinkingOffBehavior::LowEffort,
    false,
);
const UNKNOWN: ClaudeModelProfile = ClaudeModelProfile {
    levels: UNKNOWN_LEVELS,
    budget: Some(BudgetProfile {
        output_limit: None,
        effort_ceiling: None,
    }),
    display: false,
    off: ThinkingOffBehavior::Disabled,
    temperature: true,
};

impl ClaudeModelProfile {
    fn capabilities(self) -> ClaudeModelCapabilities {
        ClaudeModelCapabilities {
            thinking_mode: if self.budget.is_some() {
                ClaudeThinkingMode::Budget
            } else {
                ClaudeThinkingMode::Adaptive
            },
            native_xhigh: self.levels.contains(&ThinkingLevel::XHigh),
            supports_max: self.levels.contains(&ThinkingLevel::Max),
            supports_temperature: self.temperature,
            thinking_off: self.off,
            supports_display: self.display,
        }
    }

    /// OMP's clamp: a supported level stays, else the highest supported level
    /// below it, else the lowest supported level. Off and Default stay.
    fn clamp(self, requested: ThinkingLevel) -> ThinkingLevel {
        if matches!(requested, ThinkingLevel::Off | ThinkingLevel::Default)
            || self.levels.contains(&requested)
        {
            return requested;
        }
        let efforts = || {
            self.levels
                .iter()
                .copied()
                .filter(|level| *level != ThinkingLevel::Off)
        };
        efforts()
            .rfind(|level| effort_rank(*level) <= effort_rank(requested))
            .or_else(|| efforts().next())
            .unwrap_or(requested)
    }

    fn plan(self, requested: ThinkingLevel) -> ThinkingPlan {
        let effective = match requested {
            ThinkingLevel::Default => return ThinkingPlan::Omit,
            ThinkingLevel::Off => {
                return match self.off {
                    ThinkingOffBehavior::Disabled => ThinkingPlan::Disabled,
                    ThinkingOffBehavior::BetweenTools => ThinkingPlan::BetweenTools,
                    ThinkingOffBehavior::LowEffort => ThinkingPlan::EffortOnly("low"),
                };
            }
            level => self.clamp(level),
        };
        let Some(budget) = self.budget else {
            return ThinkingPlan::Adaptive {
                effort: effort_value(effective),
                display: self.display,
            };
        };
        ThinkingPlan::Budget {
            budget_tokens: budget_tokens(effective),
            output_limit: budget.output_limit,
            display: self.display,
            effort: budget.effort_ceiling.map(|ceiling| {
                effort_value(if effort_rank(effective) > effort_rank(ceiling) {
                    ceiling
                } else {
                    effective
                })
            }),
        }
    }
}

fn effort_rank(level: ThinkingLevel) -> usize {
    EFFORT_ORDER
        .iter()
        .position(|candidate| *candidate == level)
        .unwrap_or(0)
}

/// OMP's `mapEffortToAnthropicAdaptiveEffort`: the API has no minimal tier.
fn effort_value(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::XHigh => "xhigh",
        ThinkingLevel::Max => "max",
        _ => "low",
    }
}

/// OMP's `ANTHROPIC_THINKING` budgets.
fn budget_tokens(level: ThinkingLevel) -> u32 {
    match level {
        ThinkingLevel::Low => 4_096,
        ThinkingLevel::Medium => 8_192,
        ThinkingLevel::High => 16_384,
        ThinkingLevel::XHigh | ThinkingLevel::Max => 32_768,
        _ => 1_024,
    }
}

macro_rules! define_claude_model_profiles {
    (
        default: $default_model:ident;
        $(
            $model:ident: $model_id:literal => $profile:ident
        ),+ $(,)?
    ) => {
        $(const $model: &str = $model_id;)+

        /// Exact ordered Claude model IDs available to Anthropic subscription accounts.
        pub const ANTHROPIC_SUBSCRIPTION_MODEL_IDS: &[&str] = &[$($model),+];

        /// Default Claude model ID selected for Anthropic subscription accounts.
        pub const DEFAULT_ANTHROPIC_MODEL_ID: &str = $default_model;

        fn profile_for_model(model_id: &str) -> Option<ClaudeModelProfile> {
            match model_id {
                $($model => Some($profile),)+
                _ => None,
            }
        }
    };
}

define_claude_model_profiles! {
    default: SONNET_5_5;
    SONNET_5_5: "claude-sonnet-5-5" => BETWEEN_TOOLS,
    FABLE_5_1: "claude-fable-5-1" => ALWAYS_ON,
    FABLE_5: "claude-fable-5" => ALWAYS_ON,
    HAIKU_4_5: "claude-haiku-4-5" => BUDGET,
    HAIKU_4_5_20251001: "claude-haiku-4-5-20251001" => BUDGET,
    HAIKU_5_5: "claude-haiku-5-5" => ADAPTIVE,
    OPUS_4_1: "claude-opus-4-1" => BUDGET_32K,
    OPUS_4_1_20250805: "claude-opus-4-1-20250805" => BUDGET_32K,
    OPUS_4_5: "claude-opus-4-5" => BUDGET_WITH_EFFORT,
    OPUS_4_5_20251101: "claude-opus-4-5-20251101" => BUDGET_WITH_EFFORT,
    OPUS_4_6: "claude-opus-4-6" => ADAPTIVE_4_6,
    OPUS_4_7: "claude-opus-4-7" => ADAPTIVE,
    OPUS_4_8: "claude-opus-4-8" => ADAPTIVE,
    OPUS_5: "claude-opus-5" => ADAPTIVE,
    OPUS_5_5: "claude-opus-5-5" => ALWAYS_ON,
    SONNET_4_5: "claude-sonnet-4-5" => BUDGET,
    SONNET_4_5_20250929: "claude-sonnet-4-5-20250929" => BUDGET,
    SONNET_4_6: "claude-sonnet-4-6" => ADAPTIVE_4_6,
    SONNET_5: "claude-sonnet-5" => ADAPTIVE,
}

/// Returns the request capabilities for an exact known Claude model ID.
///
/// Unknown IDs return `None`; capabilities are never inferred from ID substrings.
pub fn capabilities_for_model(model_id: &str) -> Option<ClaudeModelCapabilities> {
    profile_for_model(model_id).map(ClaudeModelProfile::capabilities)
}

/// Returns the exposed thinking levels for an exact known Claude model ID.
///
/// Unknown IDs return `None`. Models whose thinking cannot be turned off omit
/// [`ThinkingLevel::Off`] from this list, while [`clamp_thinking_level`] still
/// preserves an explicitly stored Off value.
pub fn thinking_levels(model_id: &str) -> Option<&'static [ThinkingLevel]> {
    profile_for_model(model_id).map(|profile| profile.levels)
}

/// Clamps a requested thinking level to an exact known Claude model's levels.
///
/// Unknown IDs return `None`. Off, Default and supported levels stay; any other
/// level becomes the highest supported level below it, else the lowest one.
pub fn clamp_thinking_level(model_id: &str, requested: ThinkingLevel) -> Option<ThinkingLevel> {
    profile_for_model(model_id).map(|profile| profile.clamp(requested))
}

/// The thinking and effort fields a request for `model_id` sends at `requested`.
///
/// Unknown IDs keep conservative budget thinking: Off and Default send nothing,
/// and levels above High clamp to High.
pub fn thinking_plan(model_id: &str, requested: ThinkingLevel) -> ThinkingPlan {
    match profile_for_model(model_id) {
        Some(profile) => profile.plan(requested),
        None if requested == ThinkingLevel::Off => ThinkingPlan::Omit,
        None => UNKNOWN.plan(requested),
    }
}

#[cfg(test)]
mod tests;
