use super::{
    ANTHROPIC_SUBSCRIPTION_MODEL_IDS, ClaudeModelCapabilities, ClaudeThinkingMode,
    DEFAULT_ANTHROPIC_MODEL_ID, ThinkingOffBehavior, adaptive_effort, capabilities_for_model,
    clamp_thinking_level, thinking_levels,
};
use kordi_core::agent_session::ThinkingLevel;

const EXPECTED_MODEL_IDS: &[&str] = &[
    "claude-fable-5",
    "claude-fable-5-1",
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
    "claude-fable-5-1",
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
            ids: &["claude-fable-5", "claude-fable-5-1"],
            thinking_mode: ClaudeThinkingMode::Adaptive,
            native_xhigh: true,
            supports_max: true,
            supports_temperature: false,
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
            ids: &["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5"],
            thinking_mode: ClaudeThinkingMode::Adaptive,
            native_xhigh: true,
            supports_max: true,
            supports_temperature: false,
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
