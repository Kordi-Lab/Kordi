pub(super) fn should_skip_status_message(
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    message.role.trim().eq_ignore_ascii_case("system")
        && message.text.trim().starts_with("Thinking set to ")
}

pub(super) fn is_agent(message: &kordi_cli::desktop_runtime::DesktopChatMessage) -> bool {
    let role = message.role.trim().to_lowercase();
    role != "user" && role != "system"
}

pub(super) fn is_background_follow_up_notice(
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) -> bool {
    message.role.trim().eq_ignore_ascii_case("system")
        && message.entry_id.as_deref().is_some_and(|entry_id| {
            entry_id.starts_with(kordi_cli::desktop_runtime::BACKGROUND_FOLLOW_UP_ENTRY_PREFIX)
        })
}
