use kordi_core::agent_session::ThinkingLevel;

const BUDGET_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const MAX_WITHOUT_XHIGH_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Max,
];
const NATIVE_XHIGH_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
    ThinkingLevel::Max,
];
const FABLE_LEVELS: &[ThinkingLevel] = &[
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
    ThinkingLevel::Max,
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
    /// Send an explicit disabled thinking payload.
    Disabled,
    /// Omit the thinking payload entirely, as required by Claude Fable 5.
    Omit,
}

/// Request capabilities derived from a known Claude model's internal profile.
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeModelProfile {
    Budget,
    AdaptiveMaxWithoutXHigh,
    AdaptiveXHighMaxWithoutTemperature,
    Fable,
}

impl ClaudeModelProfile {
    fn thinking_mode(self) -> ClaudeThinkingMode {
        match self {
            Self::Budget => ClaudeThinkingMode::Budget,
            Self::AdaptiveMaxWithoutXHigh
            | Self::AdaptiveXHighMaxWithoutTemperature
            | Self::Fable => ClaudeThinkingMode::Adaptive,
        }
    }

    fn thinking_levels(self) -> &'static [ThinkingLevel] {
        match self {
            Self::Budget => BUDGET_LEVELS,
            Self::AdaptiveMaxWithoutXHigh => MAX_WITHOUT_XHIGH_LEVELS,
            Self::AdaptiveXHighMaxWithoutTemperature => NATIVE_XHIGH_LEVELS,
            Self::Fable => FABLE_LEVELS,
        }
    }

    fn supports_temperature(self) -> bool {
        !matches!(self, Self::AdaptiveXHighMaxWithoutTemperature | Self::Fable)
    }

    fn thinking_off(self) -> ThinkingOffBehavior {
        match self {
            Self::Fable => ThinkingOffBehavior::Omit,
            _ => ThinkingOffBehavior::Disabled,
        }
    }

    fn capabilities(self) -> ClaudeModelCapabilities {
        let levels = self.thinking_levels();
        ClaudeModelCapabilities {
            thinking_mode: self.thinking_mode(),
            native_xhigh: levels.contains(&ThinkingLevel::XHigh),
            supports_max: levels.contains(&ThinkingLevel::Max),
            supports_temperature: self.supports_temperature(),
            thinking_off: self.thinking_off(),
        }
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
                $($model => Some(ClaudeModelProfile::$profile),)+
                _ => None,
            }
        }
    };
}

define_claude_model_profiles! {
    default: OPUS_4_8;
    FABLE_5_1: "claude-fable-5-1" => Fable,
    FABLE_5: "claude-fable-5" => Fable,
    HAIKU_4_5: "claude-haiku-4-5" => Budget,
    HAIKU_4_5_20251001: "claude-haiku-4-5-20251001" => Budget,
    OPUS_4_1: "claude-opus-4-1" => Budget,
    OPUS_4_1_20250805: "claude-opus-4-1-20250805" => Budget,
    OPUS_4_5: "claude-opus-4-5" => Budget,
    OPUS_4_5_20251101: "claude-opus-4-5-20251101" => Budget,
    OPUS_4_6: "claude-opus-4-6" => AdaptiveMaxWithoutXHigh,
    OPUS_4_7: "claude-opus-4-7" => AdaptiveXHighMaxWithoutTemperature,
    OPUS_4_8: "claude-opus-4-8" => AdaptiveXHighMaxWithoutTemperature,
    SONNET_4_5: "claude-sonnet-4-5" => Budget,
    SONNET_4_5_20250929: "claude-sonnet-4-5-20250929" => Budget,
    SONNET_4_6: "claude-sonnet-4-6" => AdaptiveMaxWithoutXHigh,
    SONNET_5: "claude-sonnet-5" => AdaptiveXHighMaxWithoutTemperature,
}

/// Returns the request capabilities for an exact known Claude model ID.
///
/// Unknown IDs return `None`; capabilities are never inferred from ID substrings.
pub fn capabilities_for_model(model_id: &str) -> Option<ClaudeModelCapabilities> {
    profile_for_model(model_id).map(ClaudeModelProfile::capabilities)
}

/// Returns the exposed thinking levels for an exact known Claude model ID.
///
/// Unknown IDs return `None`. Fable omits [`ThinkingLevel::Off`] from this list,
/// while [`clamp_thinking_level`] still preserves an explicitly stored Off value.
pub fn thinking_levels(model_id: &str) -> Option<&'static [ThinkingLevel]> {
    profile_for_model(model_id).map(ClaudeModelProfile::thinking_levels)
}

fn clamp_for_profile(profile: ClaudeModelProfile, requested: ThinkingLevel) -> ThinkingLevel {
    if requested == ThinkingLevel::Default
        || profile.thinking_levels().contains(&requested)
        || (requested == ThinkingLevel::Off && profile.thinking_off() == ThinkingOffBehavior::Omit)
    {
        return requested;
    }

    debug_assert!(matches!(
        requested,
        ThinkingLevel::XHigh | ThinkingLevel::Max
    ));
    ThinkingLevel::High
}

/// Clamps a requested thinking level to an exact known Claude model's profile.
///
/// Unknown IDs return `None`. Known models preserve supported levels and Default;
/// Fable also preserves its hidden Off value. Unsupported XHigh or Max values
/// clamp to High.
pub fn clamp_thinking_level(model_id: &str, requested: ThinkingLevel) -> Option<ThinkingLevel> {
    profile_for_model(model_id).map(|profile| clamp_for_profile(profile, requested))
}

/// Maps a thinking level to a stable adaptive-effort string for JSON payloads.
///
/// Returns `None` for unknown IDs, budget-thinking models, Off, and Default.
/// Unsupported XHigh values are clamped through the model profile before mapping.
pub fn adaptive_effort(model_id: &str, requested: ThinkingLevel) -> Option<&'static str> {
    let profile = profile_for_model(model_id)?;
    if profile.thinking_mode() != ClaudeThinkingMode::Adaptive {
        return None;
    }

    match clamp_for_profile(profile, requested) {
        ThinkingLevel::Minimal | ThinkingLevel::Low => Some("low"),
        ThinkingLevel::Medium => Some("medium"),
        ThinkingLevel::High => Some("high"),
        ThinkingLevel::XHigh => Some("xhigh"),
        ThinkingLevel::Max => Some("max"),
        ThinkingLevel::Off | ThinkingLevel::Default => None,
    }
}

#[cfg(test)]
mod tests;
