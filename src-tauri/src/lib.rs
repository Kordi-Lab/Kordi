mod workspace;

use tauri::Manager;
use workspace::DesktopWorkspaceStatus;

#[tauri::command]
fn desktop_workspace_status() -> DesktopWorkspaceStatus {
    workspace::desktop_workspace_status()
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let status = workspace::desktop_workspace_status();
            let window = app.get_webview_window("main").expect("main window should exist");
            window.set_title(&format!("Kordi • {} • {}", status.bb_agent.label, status.bridges.label))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![desktop_workspace_status])
        .run(tauri::generate_context!())
        .expect("error while running Kordi desktop");
}
