use super::{
    ANTHROPIC_SUBSCRIPTION_MODEL_IDS, ClaudeModelCapabilities, ClaudeThinkingMode,
    DEFAULT_ANTHROPIC_MODEL_ID, ThinkingOffBehavior, ThinkingPlan, capabilities_for_model,
    clamp_thinking_level, thinking_levels, thinking_plan,
};
use kordi_core::agent_session::ThinkingLevel::{
    self, Default, High, Low, Max, Medium, Minimal, Off, XHigh,
};

const EXPECTED_MODEL_IDS: &[&str] = &[
    "claude-sonnet-5-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-5-5",
    "claude-opus-4-1",
    "claude-opus-4-1-20250805",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
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
const ALWAYS_ON_MODEL_IDS: &[&str] = &["claude-fable-5", "claude-fable-5-1", "claude-opus-5-5"];
/// Adaptive models whose Off is `{type: "disabled"}`, with OMP's low..max efforts.
const DISABLED_OFF_MODEL_IDS: &[&str] = &[
    "claude-haiku-5-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-5",
];

#[test]
fn model_constants_define_the_exact_subscription_order_and_default() {
    assert_eq!(DEFAULT_ANTHROPIC_MODEL_ID, "claude-sonnet-5-5");
    assert_eq!(
        DEFAULT_ANTHROPIC_MODEL_ID,
        kordi_core::agent_session::DEFAULT_ANTHROPIC_MODEL_ID,
        "the runtime and provider defaults must agree"
    );
    assert_eq!(ANTHROPIC_SUBSCRIPTION_MODEL_IDS, EXPECTED_MODEL_IDS);
}

#[test]
fn every_subscription_model_has_the_expected_capability_row() {
    fn assert_copy<T: Copy>() {}
    assert_copy::<ClaudeModelCapabilities>();

    let caps = |thinking_mode,
                native_xhigh,
                supports_max,
                supports_temperature,
                thinking_off,
                supports_display| {
        ClaudeModelCapabilities {
            thinking_mode,
            native_xhigh,
            supports_max,
            supports_temperature,
            thinking_off,
            supports_display,
        }
    };
    let adaptive = ClaudeThinkingMode::Adaptive;
    let budget = ClaudeThinkingMode::Budget;
    // mode, native xhigh, max, temperature, off, display
    let rows: [(&[&str], ClaudeModelCapabilities); 5] = [
        (
            &["claude-sonnet-5-5"],
            caps(
                adaptive,
                true,
                true,
                false,
                ThinkingOffBehavior::BetweenTools,
                true,
            ),
        ),
        (
            ALWAYS_ON_MODEL_IDS,
            caps(
                adaptive,
                true,
                true,
                false,
                ThinkingOffBehavior::LowEffort,
                true,
            ),
        ),
        (
            DISABLED_OFF_MODEL_IDS,
            caps(
                adaptive,
                true,
                true,
                false,
                ThinkingOffBehavior::Disabled,
                true,
            ),
        ),
        (
            &["claude-opus-4-6", "claude-sonnet-4-6"],
            caps(
                adaptive,
                false,
                true,
                true,
                ThinkingOffBehavior::Disabled,
                false,
            ),
        ),
        (
            BUDGET_MODEL_IDS,
            caps(
                budget,
                true,
                false,
                true,
                ThinkingOffBehavior::Disabled,
                true,
            ),
        ),
    ];
    let mut covered = 0;
    for (ids, expected) in rows {
        for model_id in ids {
            assert_eq!(
                capabilities_for_model(model_id),
                Some(expected),
                "{model_id}"
            );
            covered += 1;
        }
    }
    assert_eq!(covered, EXPECTED_MODEL_IDS.len());
}

#[test]
fn every_subscription_model_exposes_omps_efforts() {
    let low_to_max = [Low, Medium, High, XHigh, Max];
    let cases: [(&[&str], Vec<ThinkingLevel>); 4] = [
        (
            BUDGET_MODEL_IDS,
            vec![Off, Minimal, Low, Medium, High, XHigh],
        ),
        // Sonnet 4.6 keeps max, which the API lists and OMP's catalog does not.
        (
            &["claude-opus-4-6", "claude-sonnet-4-6"],
            vec![Off, Low, Medium, High, Max],
        ),
        (ALWAYS_ON_MODEL_IDS, low_to_max.to_vec()),
        (
            &[
                "claude-sonnet-5-5",
                "claude-haiku-5-5",
                "claude-opus-4-7",
                "claude-opus-4-8",
                "claude-opus-5",
                "claude-sonnet-5",
            ],
            [&[Off][..], &low_to_max].concat(),
        ),
    ];
    for (ids, levels) in cases {
        for model_id in ids {
            assert_eq!(
                thinking_levels(model_id),
                Some(levels.as_slice()),
                "{model_id}"
            );
        }
    }
}

#[test]
fn clamping_keeps_supported_levels_off_and_default() {
    for model_id in EXPECTED_MODEL_IDS {
        for level in thinking_levels(model_id).expect("known model") {
            assert_eq!(
                clamp_thinking_level(model_id, *level),
                Some(*level),
                "{model_id} {level}"
            );
        }
        for level in [Off, Default] {
            assert_eq!(
                clamp_thinking_level(model_id, level),
                Some(level),
                "{model_id} {level}"
            );
        }
    }
}

#[test]
fn unsupported_levels_clamp_down_else_to_the_lowest_level_as_omp_does() {
    let cases: [(&str, ThinkingLevel, ThinkingLevel); 11] = [
        // Below the ladder: the lowest supported level.
        ("claude-sonnet-5-5", Minimal, Low),
        ("claude-fable-5-1", Minimal, Low),
        ("claude-opus-4-6", Minimal, Low),
        ("claude-sonnet-4-6", Minimal, Low),
        // A gap: the highest supported level below it.
        ("claude-opus-4-6", XHigh, High),
        ("claude-sonnet-4-6", XHigh, High),
        // Above the ladder: its top.
        ("claude-haiku-4-5", Max, XHigh),
        ("claude-opus-4-1", Max, XHigh),
        ("claude-opus-4-5", Max, XHigh),
        ("claude-sonnet-4-5", Max, XHigh),
        ("claude-haiku-4-5", Minimal, Minimal),
    ];
    for (model_id, requested, expected) in cases {
        assert_eq!(
            clamp_thinking_level(model_id, requested),
            Some(expected),
            "{model_id} {requested}"
        );
    }
}

#[test]
fn plans_follow_omp_with_the_documented_differences() {
    let adaptive = |effort, display| ThinkingPlan::Adaptive { effort, display };
    let budget = |budget_tokens, output_limit, effort| ThinkingPlan::Budget {
        budget_tokens,
        output_limit: Some(output_limit),
        display: true,
        effort,
    };
    let cases = [
        ("claude-sonnet-5-5", Off, ThinkingPlan::BetweenTools),
        ("claude-sonnet-5-5", Minimal, adaptive("low", true)),
        ("claude-opus-5-5", Off, ThinkingPlan::EffortOnly("low")),
        ("claude-fable-5", Off, ThinkingPlan::EffortOnly("low")),
        ("claude-opus-5", Off, ThinkingPlan::Disabled),
        ("claude-haiku-5-5", Off, ThinkingPlan::Disabled),
        ("claude-opus-4-6", XHigh, adaptive("high", false)),
        ("claude-haiku-4-5", Low, budget(4_096, 64_000, None)),
        ("claude-haiku-4-5", Max, budget(32_768, 64_000, None)),
        ("claude-opus-4-1", XHigh, budget(32_768, 32_000, None)),
        (
            "claude-opus-4-5",
            Minimal,
            budget(1_024, 64_000, Some("low")),
        ),
        ("claude-opus-4-5", Max, budget(32_768, 64_000, Some("high"))),
    ];
    for (model_id, requested, expected) in cases {
        assert_eq!(
            thinking_plan(model_id, requested),
            expected,
            "{model_id} {requested}"
        );
    }
    for model_id in EXPECTED_MODEL_IDS {
        assert_eq!(
            thinking_plan(model_id, Default),
            ThinkingPlan::Omit,
            "{model_id}"
        );
    }
}

#[test]
fn unknown_ids_get_no_capabilities_and_conservative_budget_plans() {
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
            clamp_thinking_level(unknown_id, XHigh).is_none(),
            "{unknown_id}"
        );
        assert_eq!(
            thinking_plan(unknown_id, Off),
            ThinkingPlan::Omit,
            "{unknown_id}"
        );
        assert_eq!(
            thinking_plan(unknown_id, Max),
            ThinkingPlan::Budget {
                budget_tokens: 16_384,
                output_limit: None,
                display: false,
                effort: None,
            },
            "{unknown_id}"
        );
    }
}
