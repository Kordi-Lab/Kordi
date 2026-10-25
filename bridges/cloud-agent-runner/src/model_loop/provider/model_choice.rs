//! The model a hosted provider snapshot runs when the route names none.

use serde_json::Value;

pub(super) const MAX_MODEL_ID_CHARS: usize = 160;

/// The model a snapshot stores. Anthropic, Google, OpenAI, and ChatGPT
/// (`openai-codex`) snapshots keep only a model of their own family and
/// otherwise use the provider default.
/// Every other provider, such as a custom endpoint or an OMP catalog provider
/// like Groq or Mistral, keeps its stored model ID verbatim. A custom endpoint
/// without one gets `None`: a default model belongs to another vendor.
pub(super) fn snapshot_model<'a>(payload: &'a Value, provider: &str) -> Option<&'a str> {
    let stored = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| {
            !model.is_empty()
                && model.chars().count() <= MAX_MODEL_ID_CHARS
                && !model.chars().any(char::is_control)
        });
    if matches!(provider, "anthropic" | "google" | "openai" | "openai-codex") {
        return Some(
            stored
                .filter(|model| model_fits_provider(model, provider))
                .unwrap_or_else(|| default_model_for_provider(provider)),
        );
    }
    match stored {
        Some(model) => Some(model),
        None if provider == "custom" => None,
        None => Some(default_model_for_provider(provider)),
    }
}

/// Whether a model name can belong to this provider. Only clear mismatches
/// between the major model families are rejected.
pub(super) fn model_fits_provider(model: &str, provider: &str) -> bool {
    let name = model
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(model)
        .to_ascii_lowercase();
    let family = if name.starts_with("claude") {
        "anthropic"
    } else if name.starts_with("gemini") {
        "google"
    } else if name.starts_with("gpt-")
        || name.starts_with("o1")
        || name.starts_with("o3")
        || name.starts_with("o4")
        || name.starts_with("codex")
    {
        "openai"
    } else {
        return true;
    };
    match provider {
        "anthropic" => family == "anthropic",
        "google" | "google-gemini" => family == "google",
        "openai" | "openai-codex" => family == "openai",
        _ => true,
    }
}

/// The model a ChatGPT (`openai-codex`) snapshot runs when it stores none:
/// the same default the Mac and iOS pickers use. A ChatGPT account serves
/// only Codex models, so an OpenAI API model such as `gpt-4.1-mini` fails there.
pub(super) const OPENAI_CODEX_DEFAULT_MODEL: &str =
    kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID;

/// The model a Claude snapshot runs when it stores none: the same default the
/// Mac and iOS pickers use.
pub(super) const ANTHROPIC_DEFAULT_MODEL: &str =
    kordi_core::agent_session::DEFAULT_ANTHROPIC_MODEL_ID;

/// The effort a run uses when neither the snapshot nor the route names one.
/// Claude Sonnet 5.5, Kordi's Claude default, runs at medium as it does on
/// the Mac; every other model keeps its own default (`None`).
pub(super) fn default_thinking_for_model(provider: &str, model: &str) -> Option<&'static str> {
    (provider == "anthropic" && model == ANTHROPIC_DEFAULT_MODEL).then_some("medium")
}

pub(super) fn default_model_for_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" => ANTHROPIC_DEFAULT_MODEL,
        "openai-codex" => OPENAI_CODEX_DEFAULT_MODEL,
        "google" => "gemini-3.1-pro",
        "groq" => "llama-3.3-70b-versatile",
        "openrouter" => "openai/gpt-5",
        "xai" => "grok-4",
        _ => "gpt-4.1-mini",
    }
}
