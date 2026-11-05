#[cfg(any(target_os = "macos", test))]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use std::sync::atomic::{AtomicBool, Ordering};

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

/// The main window starts hidden (tauri.conf.json) so its bare frame never
/// shows before the first screen paints. The page shows it once that screen
/// is ready; this fallback shows it when the page never does.
pub(crate) const MAIN_WINDOW_SHOW_FALLBACK: std::time::Duration =
    std::time::Duration::from_secs(10);
static MAIN_WINDOW_SHOWN: AtomicBool = AtomicBool::new(false);

/// Shows the main window the first time the page asks; later calls do nothing.
#[tauri::command]
pub(crate) fn desktop_reveal_main_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("Only the main window starts hidden.".into());
    }
    if show_once(&MAIN_WINDOW_SHOWN, || window.show()).map_err(|err| err.to_string())? {
        window.set_focus().map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Shows the main window after `MAIN_WINDOW_SHOW_FALLBACK` unless it is
/// already shown, so a page that fails to load still leaves a window.
pub(crate) fn show_main_window_after_fallback<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MAIN_WINDOW_SHOW_FALLBACK).await;
        if !MAIN_WINDOW_SHOWN.load(Ordering::SeqCst) {
            show_and_focus_main_window(&handle);
        }
    });
}

/// Runs `show` unless `shown` is already set and reports whether it ran.
/// The flag is claimed first so two callers cannot both show the window,
/// and released when `show` fails so a later reveal or the fallback retries.
fn show_once<E>(shown: &AtomicBool, show: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
    if shown.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    show().inspect_err(|_| shown.store(false, Ordering::SeqCst))?;
    Ok(true)
}

pub(crate) fn show_and_focus_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        // Marked shown only once it is, so the page or the fallback can retry.
        match window.show() {
            Ok(()) => MAIN_WINDOW_SHOWN.store(true, Ordering::SeqCst),
            Err(err) => eprintln!("[kordi] Unable to show main window: {err}"),
        }
        if let Err(err) = window.unminimize() {
            eprintln!("[kordi] Unable to unminimize main window: {err}");
        }
        if let Err(err) = window.set_focus() {
            eprintln!("[kordi] Unable to focus main window: {err}");
        }
    }
}

/// A kordi:// link (an invitation, a pairing code, a shared document) lands
/// the user back in Kordi from the browser.
pub(crate) fn focus_main_window_on_deep_link<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    app.deep_link().on_open_url(move |_| {
        bring_main_window_to_front(&handle);
    });
}

/// Lands the user back in Kordi after a hand-off to the browser or another
/// app: unhides the app, restores and focuses the main window, and activates
/// Kordi on macOS so it comes in front of the browser.
pub(crate) fn bring_main_window_to_front<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if let Err(err) = app.show() {
        eprintln!("[kordi] Unable to unhide Kordi: {err}");
    }
    show_and_focus_main_window(app);
    #[cfg(target_os = "macos")]
    {
        // A window that was minimized is skipped by set_focus until it has
        // restored, so activate the app explicitly as well.
        let activated = app.run_on_main_thread(|| {
            use objc2::{class, msg_send, runtime::AnyObject};
            // SAFETY: runs on the main thread; NSApplication's shared
            // instance lives for the whole process.
            unsafe {
                let ns_app: *const AnyObject = msg_send![class!(NSApplication), sharedApplication];
                if let Some(ns_app) = ns_app.as_ref() {
                    let _: () = msg_send![ns_app, activateIgnoringOtherApps: true];
                }
            }
        });
        if let Err(err) = activated {
            eprintln!("[kordi] Unable to activate Kordi: {err}");
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
    cfg!(target_os = "macos") && matches!(label, MAIN_WINDOW_LABEL | "call")
}

pub(crate) fn should_show_main_window_on_reopen(has_visible_windows: bool) -> bool {
    cfg!(target_os = "macos") && !has_visible_windows
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::{
        macos_app_bundle_path, should_hide_window_instead_of_close,
        should_show_main_window_on_reopen, show_once, MAIN_WINDOW_LABEL,
    };

    #[test]
    fn main_window_starts_hidden_until_the_first_screen_paints() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid tauri.conf.json");
        let main = config["app"]["windows"]
            .as_array()
            .and_then(|windows| {
                windows
                    .iter()
                    .find(|window| window["label"] == MAIN_WINDOW_LABEL)
            })
            .expect("main window config");
        // A visible window shows its bare frame before the page can paint.
        assert_eq!(main["visible"], serde_json::Value::Bool(false));
    }

    #[test]
    fn main_window_is_shown_once() {
        let shown = AtomicBool::new(false);
        let mut calls = 0;
        let mut show = || -> Result<(), ()> {
            calls += 1;
            Ok(())
        };
        assert_eq!(show_once(&shown, &mut show), Ok(true));
        assert_eq!(show_once(&shown, &mut show), Ok(false));
        assert_eq!(calls, 1);
    }

    #[test]
    fn a_failed_show_leaves_the_window_for_a_retry() {
        let shown = AtomicBool::new(false);
        assert_eq!(
            show_once(&shown, || Err("no window server")),
            Err("no window server")
        );
        assert!(!shown.load(Ordering::SeqCst), "the fallback must still try");
        assert_eq!(show_once(&shown, || Ok::<_, &str>(())), Ok(true));
        assert!(shown.load(Ordering::SeqCst));
    }

    #[test]
    fn macos_main_window_close_hides_instead_of_quitting() {
        assert!(should_hide_window_instead_of_close("main"));
        assert!(should_hide_window_instead_of_close("call"));
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
