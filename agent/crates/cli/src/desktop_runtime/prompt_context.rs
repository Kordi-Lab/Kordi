use std::path::Path;

use kordi_core::settings::Settings;

use super::DesktopChatContextMessage;

const DYNAMIC_START: &str = "<desktop_dynamic_system_context>";
const DYNAMIC_END: &str = "</desktop_dynamic_system_context>";
const PERSONA_START: &str = "<desktop_owner_agent_persona>";
const PERSONA_END: &str = "</desktop_owner_agent_persona>";
const SESSION_START: &str = "\n\n<desktop_session_context>";
const SESSION_END: &str = "</desktop_session_context>";
const LEGACY_SESSION_START: &str = "\n\n<desktop_bridge_outreach_context>";
const LEGACY_SESSION_END: &str = "</desktop_bridge_outreach_context>";

pub(super) fn is_system_context(message: &DesktopChatContextMessage) -> bool {
    message
        .context_role
        .as_deref()
        .is_some_and(|role| role.eq_ignore_ascii_case("system"))
}

pub(super) fn system_context(messages: &[DesktopChatContextMessage]) -> Option<String> {
    let context = messages
        .iter()
        .filter(|message| is_system_context(message))
        .map(|message| message.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!context.is_empty()).then_some(context)
}

pub(super) fn with_saved_agent_persona(prompt: &str, cwd: &Path, enabled: bool) -> String {
    let base_prompt = strip_tagged(prompt, PERSONA_START, PERSONA_END);
    if !enabled || base_prompt.contains(DYNAMIC_START) {
        return base_prompt;
    }
    let settings = Settings::load_merged(cwd);
    let name = settings
        .agent_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Kordi");
    format!(
        "{PERSONA_START}\nYou are {name}, the user's local Kordi agent. Use {name} as your name in chats, mentions, and replies.\n{PERSONA_END}\n\n{base_prompt}"
    )
}

pub(super) fn with_dynamic_system_context(
    prompt: &str,
    cwd: &Path,
    persona_enabled: bool,
    context: Option<&str>,
) -> String {
    let base_prompt = strip_tagged(
        &strip_tagged(prompt, DYNAMIC_START, DYNAMIC_END),
        PERSONA_START,
        PERSONA_END,
    );
    match context.map(str::trim).filter(|value| !value.is_empty()) {
        Some(context) => {
            format!("{DYNAMIC_START}\n{context}\n{DYNAMIC_END}\n\n{base_prompt}")
        }
        None => with_saved_agent_persona(&base_prompt, cwd, persona_enabled),
    }
}

pub(super) fn with_session_context(prompt: &str, context: Option<&str>) -> String {
    let base_prompt = strip_session_prompt_context(prompt);
    match context.map(str::trim).filter(|value| !value.is_empty()) {
        Some(context) => format!("{base_prompt}{SESSION_START}\n{context}\n{SESSION_END}"),
        None => base_prompt,
    }
}

pub(super) fn strip_session_prompt_context(prompt: &str) -> String {
    strip_tagged(
        &strip_tagged(prompt, SESSION_START, SESSION_END),
        LEGACY_SESSION_START,
        LEGACY_SESSION_END,
    )
}

fn strip_tagged(prompt: &str, start_tag: &str, end_tag: &str) -> String {
    let Some(start) = prompt.find(start_tag) else {
        return prompt.to_string();
    };
    let Some(end_relative) = prompt[start..].find(end_tag) else {
        return prompt.to_string();
    };
    let end = start + end_relative + end_tag.len();
    format!("{}{}", &prompt[..start], &prompt[end..])
        .trim_end()
        .to_string()
}
