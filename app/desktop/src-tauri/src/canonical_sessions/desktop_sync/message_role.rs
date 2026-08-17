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
