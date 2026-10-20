/// Dock icons offered by the App icon setting. `white` is the bundle icon.
/// Keep in sync with scripts/kordi-app-icons/icons.mjs.
const APP_ICONS: &[(&str, &[u8])] = &[
    ("white", include_bytes!("../icons/app-icons/white.png")),
    ("frosted", include_bytes!("../icons/app-icons/frosted.png")),
    ("rice", include_bytes!("../icons/app-icons/rice.png")),
    ("coral", include_bytes!("../icons/app-icons/coral.png")),
    ("sakura", include_bytes!("../icons/app-icons/sakura.png")),
    ("butter", include_bytes!("../icons/app-icons/butter.png")),
    ("mint", include_bytes!("../icons/app-icons/mint.png")),
    ("sky", include_bytes!("../icons/app-icons/sky.png")),
    (
        "lavender",
        include_bytes!("../icons/app-icons/lavender.png"),
    ),
    ("night", include_bytes!("../icons/app-icons/night.png")),
    (
        "midnight",
        include_bytes!("../icons/app-icons/midnight.png"),
    ),
    ("forest", include_bytes!("../icons/app-icons/forest.png")),
    ("plum", include_bytes!("../icons/app-icons/plum.png")),
    ("cocoa", include_bytes!("../icons/app-icons/cocoa.png")),
    ("slate", include_bytes!("../icons/app-icons/slate.png")),
    (
        "night-sakura",
        include_bytes!("../icons/app-icons/night-sakura.png"),
    ),
    (
        "midnight-sky",
        include_bytes!("../icons/app-icons/midnight-sky.png"),
    ),
];

const DEFAULT_APP_ICON: &str = "white";

/// Development profiles keep the gray icon so they cannot be mistaken for
/// the product. Release builds and the operator profile use the color icon.
fn custom_app_icon_allowed(debug_build: bool, dev_profile: Option<&str>) -> bool {
    !debug_build || dev_profile.is_some_and(|value| value.trim().eq_ignore_ascii_case("operator"))
}

/// The image to show, or `None` to restore the bundle icon.
fn app_icon_image(key: &str) -> Result<Option<&'static [u8]>, String> {
    let (_, bytes) = APP_ICONS
        .iter()
        .find(|(name, _)| *name == key)
        .ok_or_else(|| format!("Unknown app icon: {key}"))?;
    Ok((key != DEFAULT_APP_ICON).then_some(*bytes))
}

/// Swaps the Dock icon while Kordi runs. Returns whether it was applied.
#[tauri::command]
pub(crate) async fn desktop_set_app_icon(
    app: tauri::AppHandle,
    key: String,
) -> Result<bool, String> {
    let image = app_icon_image(&key)?;
    let dev_profile = std::env::var("VITE_KORDI_DEV_PROFILE").ok();
    if !custom_app_icon_allowed(cfg!(debug_assertions), dev_profile.as_deref()) {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            use objc2::{class, msg_send, runtime::AnyObject};
            // SAFETY: runs on the main thread; the NSData copies the static
            // bytes and the NSImage is retained by NSApplication.
            unsafe {
                let application: *mut AnyObject =
                    msg_send![class!(NSApplication), sharedApplication];
                let icon: *mut AnyObject = match image {
                    Some(bytes) => {
                        let data: *mut AnyObject = msg_send![class!(NSData),
                            dataWithBytes: bytes.as_ptr().cast::<std::ffi::c_void>(),
                            length: bytes.len()];
                        let allocated: *mut AnyObject = msg_send![class!(NSImage), alloc];
                        let image: *mut AnyObject = msg_send![allocated, initWithData: data];
                        let _: *mut AnyObject = msg_send![image, autorelease];
                        image
                    }
                    None => std::ptr::null_mut(),
                };
                let _: () = msg_send![application, setApplicationIconImage: icon];
            }
            let _ = sender.send(());
        })
        .map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, image);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_restores_the_bundle_icon_and_unknown_keys_fail() {
        assert_eq!(app_icon_image("white"), Ok(None));
        assert!(app_icon_image("frosted")
            .is_ok_and(|image| image.is_some_and(|bytes| bytes.starts_with(b"\x89PNG"))));
        assert!(app_icon_image("disc").is_err());
    }

    #[test]
    fn development_profiles_keep_the_gray_icon() {
        assert!(custom_app_icon_allowed(false, None));
        assert!(custom_app_icon_allowed(true, Some("operator")));
        assert!(!custom_app_icon_allowed(true, None));
        assert!(!custom_app_icon_allowed(true, Some("community")));
    }
}
