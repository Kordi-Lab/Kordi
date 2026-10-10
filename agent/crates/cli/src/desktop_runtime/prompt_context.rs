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
const MEMORY_START: &str = crate::session_bootstrap::memory::MEMORY_CONTEXT_START;
const MEMORY_END: &str = crate::session_bootstrap::memory::MEMORY_CONTEXT_END;

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
            format!("{base_prompt}\n\n{DYNAMIC_START}\n{context}\n{DYNAMIC_END}")
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

/// Replace the tagged memory block. The block sits before the dynamic and
/// session context blocks so its place stays stable across turns; an empty
/// `block` removes it.
pub(super) fn with_memory_context(prompt: &str, block: &str) -> String {
    let base_prompt = strip_tagged(prompt, MEMORY_START, MEMORY_END);
    if block.trim().is_empty() {
        return base_prompt;
    }
    let insert_at = [
        format!("\n\n{DYNAMIC_START}"),
        SESSION_START.to_string(),
        LEGACY_SESSION_START.to_string(),
    ]
    .iter()
    .filter_map(|tag| base_prompt.find(tag.as_str()))
    .min()
    .unwrap_or(base_prompt.len());
    format!(
        "{}{block}{}",
        &base_prompt[..insert_at],
        &base_prompt[insert_at..]
    )
}

/// Remove the tagged memory block, leaving the rest of the prompt unchanged.
pub(super) fn strip_memory_context(prompt: &str) -> String {
    strip_tagged(prompt, MEMORY_START, MEMORY_END)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_system_context_replaces_the_previous_block() {
        let base = "Stable agent instructions";
        let first =
            with_dynamic_system_context(base, Path::new("."), false, Some("Requester Alice"));
        let second =
            with_dynamic_system_context(&first, Path::new("."), false, Some("Requester Bob"));
        assert!(first.starts_with(base));
        assert!(second.starts_with(base));
        assert!(!second.contains("Requester Alice"));
        assert!(second.contains("Requester Bob"));
        assert_eq!(second.matches(DYNAMIC_START).count(), 1);
    }

    #[test]
    fn memory_block_survives_dynamic_and_session_context_exactly_once() {
        let block = crate::session_bootstrap::memory::tagged_memory_prompt_block(
            "## Memories\nThis conversation:\n- Reply in French.",
        );
        let base = format!("Stable agent instructions{block}");
        let mut prompt = base.clone();
        for turn in ["Alice", "Bob"] {
            prompt = with_dynamic_system_context(
                &prompt,
                Path::new("."),
                false,
                Some(&format!("Requester {turn}")),
            );
            prompt = with_session_context(&prompt, Some(&format!("Session {turn}")));
            prompt = with_memory_context(&prompt, &block);
        }
        assert_eq!(prompt.matches(MEMORY_START.trim_start()).count(), 1);
        assert_eq!(prompt.matches(MEMORY_END).count(), 1);
        assert_eq!(prompt.matches(DYNAMIC_START).count(), 1);
        assert_eq!(prompt.matches(SESSION_START.trim_start()).count(), 1);
        assert!(prompt.contains("- Reply in French."));
        assert!(prompt.contains("Requester Bob") && !prompt.contains("Requester Alice"));
        let memory_at = prompt.find(MEMORY_END).expect("memory block");
        assert!(memory_at < prompt.find(DYNAMIC_START).expect("dynamic block"));
        assert!(memory_at < prompt.find(SESSION_START).expect("session block"));

        let cleared = with_memory_context(&prompt, "");
        assert!(!cleared.contains(MEMORY_END));
        assert!(!cleared.contains("Reply in French"));
        assert!(cleared.contains("Requester Bob"));
        assert!(cleared.contains("Session Bob"));
    }
}
