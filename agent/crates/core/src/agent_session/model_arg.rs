use crate::types::ThinkingLevel;

pub const DEFAULT_OPENAI_MODEL_ID: &str = "gpt-5.6-sol";

pub fn parse_model_arg(
    provider: Option<&str>,
    model: Option<&str>,
) -> (String, String, Option<String>) {
    let default_provider = provider.unwrap_or("openai").to_string();
    let default_model = match default_provider.as_str() {
        "anthropic" => "claude-opus-4-6",
        "openai" | "openai-codex" => DEFAULT_OPENAI_MODEL_ID,
        "google" => "gemini-3.1-pro",
        "github-copilot" => "gpt-5.4",
        _ => "gpt-5.4",
    };

    let model_str = match model {
        Some(model) => model,
        None => return (default_provider, default_model.to_string(), None),
    };

    let (model_part, thinking) = if let Some(pos) = model_str.rfind(':') {
        let level = &model_str[pos + 1..];
        if let Some(level) = ThinkingLevel::parse(level) {
            (&model_str[..pos], Some(level.as_str().to_string()))
        } else {
            (model_str, None)
        }
    } else {
        (model_str, None)
    };

    if let Some(pos) = model_part.find('/') {
        let provider_name = &model_part[..pos];
        let model_id = &model_part[pos + 1..];
        (provider_name.to_string(), model_id.to_string(), thinking)
    } else {
        (default_provider, model_part.to_string(), thinking)
    }
}

#[cfg(test)]
mod tests {
    use super::parse_model_arg;

    #[test]
    fn openai_default_model_is_gpt_56_sol() {
        assert_eq!(parse_model_arg(Some("openai"), None).1, "gpt-5.6-sol");
        assert_eq!(parse_model_arg(Some("openai-codex"), None).1, "gpt-5.6-sol");
    }

    #[test]
    fn explicit_openai_model_still_wins() {
        assert_eq!(
            parse_model_arg(Some("openai"), Some("gpt-5.4")).1,
            "gpt-5.4"
        );
    }
}
