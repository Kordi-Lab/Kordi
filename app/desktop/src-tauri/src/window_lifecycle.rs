#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use tauri::Manager;

pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
const UPDATE_RELAUNCH_ARG: &str = "--kordi-update-relaunch";
#[cfg(target_os = "macos")]
const UPDATE_RELAUNCH_RECOVERY: &str =
    "The update was installed, but Kordi could not relaunch. Quit Kordi and open it from Applications.";

#[cfg(any(target_os = "macos", test))]
fn macos_app_bundle_path(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    if macos.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()?.to_str()? == "app").then(|| bundle.to_path_buf())
}

pub(crate) fn update_relaunch_requested() -> bool {
    std::env::args_os().any(|arg| arg == UPDATE_RELAUNCH_ARG)
}

pub(crate) fn show_and_focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        if let Err(err) = window.show() {
            eprintln!("[kordi] Unable to show main window: {err}");
        }
        if let Err(err) = window.unminimize() {
            eprintln!("[kordi] Unable to unminimize main window: {err}");
        }
        if let Err(err) = window.set_focus() {
            eprintln!("[kordi] Unable to focus main window: {err}");
        }
    }
}

#[tauri::command]
pub(crate) fn desktop_relaunch_after_update(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let executable = tauri::process::current_binary(&app.env())
            .map_err(|_| UPDATE_RELAUNCH_RECOVERY.to_string())?;
        let bundle = macos_app_bundle_path(&executable)
            .ok_or_else(|| UPDATE_RELAUNCH_RECOVERY.to_string())?;
        super::run_external_command(
            Command::new("/usr/bin/open")
                .arg("-n")
                .arg(bundle)
                .arg("--args")
                .arg(UPDATE_RELAUNCH_ARG)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .map_err(|_| UPDATE_RELAUNCH_RECOVERY.to_string())?;
        // LaunchServices owns the replacement; the restart code only makes
        // shutdown non-cancelable and skips the presence-offline hook.
        app.exit(tauri::RESTART_EXIT_CODE);
    }
    #[cfg(not(target_os = "macos"))]
    app.request_restart();

    Ok(())
}

pub(crate) fn should_hide_window_instead_of_close(label: &str) -> bool {
    cfg!(target_os = "macos") && label == MAIN_WINDOW_LABEL
}

pub(crate) fn should_show_main_window_on_reopen(has_visible_windows: bool) -> bool {
    cfg!(target_os = "macos") && !has_visible_windows
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        macos_app_bundle_path, should_hide_window_instead_of_close,
        should_show_main_window_on_reopen,
    };

    #[test]
    fn macos_main_window_close_hides_instead_of_quitting() {
        assert!(should_hide_window_instead_of_close("main"));
        assert!(!should_hide_window_instead_of_close("secondary"));
    }

    #[test]
    fn dock_reopen_restores_main_window_when_none_are_visible() {
        assert!(should_show_main_window_on_reopen(false));
        assert!(!should_show_main_window_on_reopen(true));
    }

    #[test]
    fn macos_relaunch_resolves_only_an_application_bundle() {
        assert_eq!(
            macos_app_bundle_path(Path::new(
                "/Applications/Kordi.app/Contents/MacOS/kordi-desktop"
            )),
            Some(Path::new("/Applications/Kordi.app").to_path_buf())
        );
        assert_eq!(macos_app_bundle_path(Path::new("/tmp/kordi-desktop")), None);
        assert_eq!(
            macos_app_bundle_path(Path::new(
                "/Applications/Kordi/Contents/MacOS/kordi-desktop"
            )),
            None
        );
    }
}
