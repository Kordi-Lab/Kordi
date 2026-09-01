use kordi_core::settings::Settings;
use tauri::State;

use super::DesktopChatManager;

#[tauri::command]
pub async fn desktop_chat_rename_agent(
    manager: State<'_, DesktopChatManager>,
    name: String,
) -> Result<String, String> {
    let name = normalized_agent_name(&name)?;
    let mut settings = Settings::load_global();
    settings.agent_name = Some(name.clone());
    settings.save_global().map_err(|error| error.to_string())?;
    let sessions = manager
        .sessions
        .lock()
        .await
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for session in sessions {
        session.lock().await.refresh_saved_agent_persona();
    }
    Ok(name)
}

pub(super) fn normalized_agent_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Agent name is required.".to_string());
    }
    if name.chars().count() > 120 {
        return Err("Agent name must be 120 characters or fewer.".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("Agent name cannot contain control characters.".to_string());
    }
    Ok(name.to_string())
}
