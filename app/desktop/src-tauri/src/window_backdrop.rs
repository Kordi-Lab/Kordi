/// Match native backing surfaces to the actual sidebar and workspace panes.
/// The webview remains live; this changes only the background component bounds.
#[tauri::command]
pub(crate) async fn desktop_set_window_backdrop(
    window: tauri::WebviewWindow,
    sidebar_width: f64,
    background: [u8; 3],
    navigation_width: f64,
    session_background: [u8; 4],
) -> Result<(), String> {
    if window.label() != super::window_lifecycle::MAIN_WINDOW_LABEL {
        return Err("Workspace backdrop is only available for the main window.".into());
    }
    if !sidebar_width.is_finite()
        || sidebar_width < 0.0
        || !navigation_width.is_finite()
        || navigation_width < 0.0
    {
        return Err("Invalid sidebar width.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window
            .with_webview(move |view| {
                let result = (|| {
                    use objc2::{class, msg_send, runtime::AnyObject};
                    use objc2_foundation::NSRect;
                    let pointer = target.ns_window().map_err(|error| error.to_string())?;
                    // SAFETY: with_webview executes on the main thread. Tauri owns
                    // the window and views throughout this closure; none escape.
                    unsafe {
                        let native = (pointer as *const AnyObject)
                            .as_ref()
                            .ok_or("Native window unavailable")?;
                        let webview = (view.inner() as *const AnyObject)
                            .as_ref()
                            .ok_or("Native webview unavailable")?;
                        let parent: *const AnyObject = msg_send![webview, superview];
                        let parent = parent
                            .as_ref()
                            .ok_or("Native content container unavailable")?;
                        let bounds: NSRect = msg_send![parent, bounds];
                        let views: *const AnyObject = msg_send![parent, subviews];
                        let count: usize = msg_send![views, count];
                        for index in 0..count {
                            let child: *const AnyObject = msg_send![views, objectAtIndex: index];
                            let is_material: bool =
                                msg_send![child, isKindOfClass: class!(NSVisualEffectView)];
                            if !is_material {
                                continue;
                            }
                            let mut sidebar = bounds;
                            sidebar.size.width = sidebar_width.min(bounds.size.width);
                            let _: () = msg_send![child, setFrame: sidebar];
                            // Only height follows the window. Sidebar width is
                            // governed by the same layout state as the web pane.
                            let _: () = msg_send![child, setAutoresizingMask: 16_usize];
                        }
                        let color: *const AnyObject = msg_send![class!(NSColor),
                        colorWithSRGBRed: f64::from(background[0]) / 255.0,
                        green: f64::from(background[1]) / 255.0,
                        blue: f64::from(background[2]) / 255.0,
                        alpha: 1.0_f64];
                        let _: () = msg_send![native, setBackgroundColor: color];
                        // A transparent NSWindow does not always paint its own
                        // background under a layer-hosted WKWebView. Give the
                        // native content container the same opaque workspace
                        // plane; its bounds update synchronously with AppKit.
                        let _: () = msg_send![parent, setWantsLayer: true];
                        let layer: *const AnyObject = msg_send![parent, layer];
                        let cg_color: *const std::ffi::c_void = msg_send![color, CGColor];
                        let _: () = msg_send![layer, setBackgroundColor: cg_color];
                        let mut navigation = bounds;
                        navigation.size.width =
                            navigation_width.min(sidebar_width).min(bounds.size.width);
                        let mut sessions = bounds;
                        sessions.origin.x += navigation.size.width;
                        sessions.size.width =
                            (sidebar_width.min(bounds.size.width) - navigation.size.width).max(0.0);
                        set_tint(
                            parent,
                            webview,
                            "kordi-session-backing",
                            sessions,
                            session_background,
                        )?;
                    }
                    Ok::<(), String>(())
                })();
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .await
            .map_err(|_| "Backdrop update was interrupted.".to_string())??;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (
            sidebar_width,
            background,
            navigation_width,
            session_background,
        );
        Err("Native pane backing is only available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
unsafe fn set_tint(
    parent: &objc2::runtime::AnyObject,
    webview: &objc2::runtime::AnyObject,
    name: &str,
    frame: objc2_foundation::NSRect,
    rgba: [u8; 4],
) -> Result<(), String> {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::NSString;
    let identifier = NSString::from_str(name);
    let views: *const AnyObject = msg_send![parent, subviews];
    let count: usize = msg_send![views, count];
    let mut existing = None;
    for index in 0..count {
        let child: *mut AnyObject = msg_send![views, objectAtIndex: index];
        let value: *const AnyObject = msg_send![child, identifier];
        if !value.is_null() && msg_send![value, isEqualToString: &*identifier] {
            existing = Retained::retain(child);
            break;
        }
    }
    let tint = if let Some(existing) = existing {
        existing
    } else {
        let allocated: *mut AnyObject = msg_send![class!(NSView), alloc];
        let initialized: *mut AnyObject = msg_send![allocated, initWithFrame: frame];
        let view = Retained::from_raw(initialized).ok_or("Native pane backing unavailable")?;
        let _: () = msg_send![&*view, setIdentifier: &*identifier];
        let _: () = msg_send![&*view, setWantsLayer: true];
        let _: () =
            msg_send![parent, addSubview: &*view, positioned: -1_isize, relativeTo: webview];
        view
    };
    let _: () = msg_send![&*tint, setFrame: frame];
    let _: () = msg_send![&*tint, setAutoresizingMask: 16_usize];
    let _: () = msg_send![&*tint, setHidden: frame.size.width <= 0.0];
    let color: *const AnyObject = msg_send![class!(NSColor),
        colorWithSRGBRed: f64::from(rgba[0]) / 255.0,
        green: f64::from(rgba[1]) / 255.0,
        blue: f64::from(rgba[2]) / 255.0,
        alpha: f64::from(rgba[3]) / 255.0];
    let cg_color: *const std::ffi::c_void = msg_send![color, CGColor];
    let layer: *const AnyObject = msg_send![&*tint, layer];
    let _: () = msg_send![layer, setBackgroundColor: cg_color];
    Ok(())
}
