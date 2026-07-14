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
    AdaptiveXHighMax,
    AdaptiveXHighMaxWithoutTemperature,
    Fable,
}

impl ClaudeModelProfile {
    fn thinking_mode(self) -> ClaudeThinkingMode {
        match self {
            Self::Budget => ClaudeThinkingMode::Budget,
            Self::AdaptiveMaxWithoutXHigh
            | Self::AdaptiveXHighMax
            | Self::AdaptiveXHighMaxWithoutTemperature
            | Self::Fable => ClaudeThinkingMode::Adaptive,
        }
    }

    fn thinking_levels(self) -> &'static [ThinkingLevel] {
        match self {
            Self::Budget => BUDGET_LEVELS,
            Self::AdaptiveMaxWithoutXHigh => MAX_WITHOUT_XHIGH_LEVELS,
            Self::AdaptiveXHighMax | Self::AdaptiveXHighMaxWithoutTemperature => {
                NATIVE_XHIGH_LEVELS
            }
            Self::Fable => FABLE_LEVELS,
        }
    }

    fn supports_temperature(self) -> bool {
        !matches!(self, Self::AdaptiveXHighMaxWithoutTemperature)
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
    SONNET_5: "claude-sonnet-5" => AdaptiveXHighMax,
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
mod tests {
    use super::{
        ANTHROPIC_SUBSCRIPTION_MODEL_IDS, ClaudeModelCapabilities, ClaudeThinkingMode,
        DEFAULT_ANTHROPIC_MODEL_ID, ThinkingOffBehavior, adaptive_effort, capabilities_for_model,
        clamp_thinking_level, thinking_levels,
    };
    use kordi_core::agent_session::ThinkingLevel;

    const EXPECTED_MODEL_IDS: &[&str] = &[
        "claude-fable-5",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-1",
        "claude-opus-4-1-20250805",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
    ];

    const BUDGET_MODEL_IDS: &[&str] = &[
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-1",
        "claude-opus-4-1-20250805",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
    ];

    const NATIVE_XHIGH_MODEL_IDS: &[&str] = &[
        "claude-fable-5",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
    ];

    #[test]
    fn model_constants_define_the_exact_subscription_order_and_default() {
        assert_eq!(DEFAULT_ANTHROPIC_MODEL_ID, "claude-opus-4-8");
        assert_eq!(ANTHROPIC_SUBSCRIPTION_MODEL_IDS, EXPECTED_MODEL_IDS);
        assert!(
            ANTHROPIC_SUBSCRIPTION_MODEL_IDS.contains(&DEFAULT_ANTHROPIC_MODEL_ID),
            "default model must be part of the subscription catalog"
        );
    }

    #[test]
    fn every_subscription_model_has_the_expected_capability_row() {
        struct ExpectedCapabilities {
            ids: &'static [&'static str],
            thinking_mode: ClaudeThinkingMode,
            native_xhigh: bool,
            supports_max: bool,
            supports_temperature: bool,
            thinking_off: ThinkingOffBehavior,
        }

        let rows = [
            ExpectedCapabilities {
                ids: &["claude-fable-5"],
                thinking_mode: ClaudeThinkingMode::Adaptive,
                native_xhigh: true,
                supports_max: true,
                supports_temperature: true,
                thinking_off: ThinkingOffBehavior::Omit,
            },
            ExpectedCapabilities {
                ids: &["claude-opus-4-6", "claude-sonnet-4-6"],
                thinking_mode: ClaudeThinkingMode::Adaptive,
                native_xhigh: false,
                supports_max: true,
                supports_temperature: true,
                thinking_off: ThinkingOffBehavior::Disabled,
            },
            ExpectedCapabilities {
                ids: &["claude-opus-4-7", "claude-opus-4-8"],
                thinking_mode: ClaudeThinkingMode::Adaptive,
                native_xhigh: true,
                supports_max: true,
                supports_temperature: false,
                thinking_off: ThinkingOffBehavior::Disabled,
            },
            ExpectedCapabilities {
                ids: &["claude-sonnet-5"],
                thinking_mode: ClaudeThinkingMode::Adaptive,
                native_xhigh: true,
                supports_max: true,
                supports_temperature: true,
                thinking_off: ThinkingOffBehavior::Disabled,
            },
            ExpectedCapabilities {
                ids: BUDGET_MODEL_IDS,
                thinking_mode: ClaudeThinkingMode::Budget,
                native_xhigh: false,
                supports_max: false,
                supports_temperature: true,
                thinking_off: ThinkingOffBehavior::Disabled,
            },
        ];

        fn assert_copy<T: Copy>() {}
        assert_copy::<ClaudeModelCapabilities>();

        for row in rows {
            for model_id in row.ids {
                let capabilities = capabilities_for_model(model_id)
                    .unwrap_or_else(|| panic!("missing capabilities for {model_id}"));
                assert_eq!(capabilities.thinking_mode, row.thinking_mode, "{model_id}");
                assert_eq!(capabilities.native_xhigh, row.native_xhigh, "{model_id}");
                assert_eq!(capabilities.supports_max, row.supports_max, "{model_id}");
                assert_eq!(
                    capabilities.supports_temperature, row.supports_temperature,
                    "{model_id}"
                );
                assert_eq!(capabilities.thinking_off, row.thinking_off, "{model_id}");
            }
        }
    }

    #[test]
    fn every_subscription_model_exposes_its_exact_thinking_levels() {
        let budget_levels = [
            ThinkingLevel::Off,
            ThinkingLevel::Minimal,
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
        ];
        for model_id in BUDGET_MODEL_IDS {
            assert_eq!(
                thinking_levels(model_id),
                Some(budget_levels.as_slice()),
                "{model_id}"
            );
        }

        let max_without_xhigh = [
            ThinkingLevel::Off,
            ThinkingLevel::Minimal,
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
            ThinkingLevel::Max,
        ];
        for model_id in ["claude-opus-4-6", "claude-sonnet-4-6"] {
            assert_eq!(
                thinking_levels(model_id),
                Some(max_without_xhigh.as_slice()),
                "{model_id}"
            );
        }

        let native_xhigh_levels = [
            ThinkingLevel::Off,
            ThinkingLevel::Minimal,
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
            ThinkingLevel::XHigh,
            ThinkingLevel::Max,
        ];
        for model_id in ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5"] {
            assert_eq!(
                thinking_levels(model_id),
                Some(native_xhigh_levels.as_slice()),
                "{model_id}"
            );
        }

        let fable_levels = [
            ThinkingLevel::Minimal,
            ThinkingLevel::Low,
            ThinkingLevel::Medium,
            ThinkingLevel::High,
            ThinkingLevel::XHigh,
            ThinkingLevel::Max,
        ];
        assert_eq!(
            thinking_levels("claude-fable-5"),
            Some(fable_levels.as_slice())
        );
    }

    #[test]
    fn clamping_preserves_supported_and_explicit_stored_levels() {
        for model_id in EXPECTED_MODEL_IDS {
            for level in thinking_levels(model_id).expect("known model") {
                assert_eq!(
                    clamp_thinking_level(model_id, *level),
                    Some(*level),
                    "{model_id} {level}"
                );
            }
            assert_eq!(
                clamp_thinking_level(model_id, ThinkingLevel::Default),
                Some(ThinkingLevel::Default),
                "{model_id} default"
            );
        }

        assert_eq!(
            clamp_thinking_level("claude-fable-5", ThinkingLevel::Off),
            Some(ThinkingLevel::Off)
        );
    }

    #[test]
    fn unsupported_high_end_levels_clamp_to_the_highest_valid_effort() {
        for model_id in BUDGET_MODEL_IDS {
            assert_eq!(
                clamp_thinking_level(model_id, ThinkingLevel::XHigh),
                Some(ThinkingLevel::High),
                "{model_id} xhigh"
            );
            assert_eq!(
                clamp_thinking_level(model_id, ThinkingLevel::Max),
                Some(ThinkingLevel::High),
                "{model_id} max"
            );
        }

        for model_id in ["claude-opus-4-6", "claude-sonnet-4-6"] {
            assert_eq!(
                clamp_thinking_level(model_id, ThinkingLevel::XHigh),
                Some(ThinkingLevel::High),
                "{model_id} xhigh"
            );
            assert_eq!(
                clamp_thinking_level(model_id, ThinkingLevel::Max),
                Some(ThinkingLevel::Max),
                "{model_id} max"
            );
        }
    }

    #[test]
    fn adaptive_effort_is_model_aware_and_stable_for_json() {
        for model_id in NATIVE_XHIGH_MODEL_IDS {
            for (requested, expected) in [
                (ThinkingLevel::Minimal, "low"),
                (ThinkingLevel::Low, "low"),
                (ThinkingLevel::Medium, "medium"),
                (ThinkingLevel::High, "high"),
                (ThinkingLevel::XHigh, "xhigh"),
                (ThinkingLevel::Max, "max"),
            ] {
                assert_eq!(
                    adaptive_effort(model_id, requested),
                    Some(expected),
                    "{model_id}"
                );
            }
        }

        for model_id in ["claude-opus-4-6", "claude-sonnet-4-6"] {
            assert_eq!(
                adaptive_effort(model_id, ThinkingLevel::XHigh),
                Some("high"),
                "{model_id} xhigh"
            );
            assert_eq!(
                adaptive_effort(model_id, ThinkingLevel::Max),
                Some("max"),
                "{model_id} max"
            );
        }

        assert_eq!(adaptive_effort("claude-opus-4-8", ThinkingLevel::Off), None);
        assert_eq!(
            adaptive_effort("claude-opus-4-8", ThinkingLevel::Default),
            None
        );
        assert_eq!(
            adaptive_effort("claude-opus-4-5", ThinkingLevel::High),
            None
        );
    }

    #[test]
    fn capability_lookups_require_exact_known_ids() {
        for unknown_id in [
            "claude-future-live-id",
            "vendor/claude-opus-4-8",
            "claude-opus-4-8-preview",
            "not-claude-opus-4-8",
            "CLAUDE-OPUS-4-8",
            " claude-opus-4-8",
        ] {
            assert!(capabilities_for_model(unknown_id).is_none(), "{unknown_id}");
            assert!(thinking_levels(unknown_id).is_none(), "{unknown_id}");
            assert!(
                clamp_thinking_level(unknown_id, ThinkingLevel::XHigh).is_none(),
                "{unknown_id}"
            );
            assert!(
                adaptive_effort(unknown_id, ThinkingLevel::XHigh).is_none(),
                "{unknown_id}"
            );
        }
    }
}
