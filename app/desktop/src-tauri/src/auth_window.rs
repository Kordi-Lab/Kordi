use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AuthWindowSurface {
    Login,
    Signup,
    Main,
}

impl AuthWindowSurface {
    fn dimensions(self) -> (f64, f64, f64, f64) {
        match self {
            Self::Login => (760.0, 760.0, 620.0, 640.0),
            Self::Signup => (760.0, 860.0, 620.0, 640.0),
            Self::Main => (1480.0, 980.0, 1192.0, 760.0),
        }
    }
}

#[tauri::command]
pub(crate) async fn desktop_set_auth_window_surface(
    window: tauri::WebviewWindow,
    surface: AuthWindowSurface,
    animate: bool,
) -> Result<(), String> {
    if window.label() != super::window_lifecycle::MAIN_WINDOW_LABEL {
        return Err("Auth sizing is only available for the main window.".into());
    }
    if window.is_fullscreen().map_err(|err| err.to_string())? {
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    let (width, height, min_width, min_height) = surface.dimensions();

    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window
            .with_webview(move |webview| {
                let result = resize_macos(&target, webview.inner(), surface, animate);
                let _ = sender.send(result);
            })
            .map_err(|err| err.to_string())?;
        let animation = receiver
            .await
            .map_err(|_| "Window resize was interrupted.".to_string())??;
        animation
            .await
            .map_err(|_| "Window animation was interrupted.".to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = animate;
        window
            .set_min_size(Some(tauri::LogicalSize::new(0.0, 0.0)))
            .map_err(|err| err.to_string())?;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|err| err.to_string())?;
        window
            .set_min_size(Some(tauri::LogicalSize::new(min_width, min_height)))
            .map_err(|err| err.to_string())?;
    }
    window
        .set_resizable(matches!(surface, AuthWindowSurface::Main))
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn resize_macos(
    window: &tauri::WebviewWindow,
    webview_pointer: *mut std::ffi::c_void,
    surface: AuthWindowSurface,
    animate: bool,
) -> Result<tokio::sync::oneshot::Receiver<()>, String> {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let pointer = window.ns_window().map_err(|err| err.to_string())?;
    let (width, height, min_width, min_height) = surface.dimensions();
    // SAFETY: Tauri owns this NSWindow for the duration of the main-thread
    // closure. All selectors below are public AppKit APIs. The completion
    // block retains the window until the asynchronous animation ends.
    unsafe {
        let native = (pointer as *const AnyObject)
            .as_ref()
            .ok_or_else(|| "The native window is unavailable.".to_string())?;
        let webview = (webview_pointer as *const AnyObject)
            .as_ref()
            .ok_or_else(|| "The native webview is unavailable.".to_string())?;
        // Tauri embeds its main WKWebView as a child and normally resizes it
        // through queued Tao events. NSWindow's animation runs before that
        // queue drains, leaving the page behind the moving frame. Let AppKit
        // resize this full-window view with its parent on each native frame.
        const WIDTH_AND_HEIGHT_SIZABLE: usize = (1 << 1) | (1 << 4);
        let _: () = msg_send![webview, setAutoresizingMask: WIDTH_AND_HEIGHT_SIZABLE];
        let parent: *const AnyObject = msg_send![webview, superview];
        if let Some(parent) = parent.as_ref() {
            let bounds: NSRect = msg_send![parent, bounds];
            let _: () = msg_send![webview, setFrame: bounds];
        }
        let current: NSRect = msg_send![native, frame];
        let content = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, height));
        let mut frame: NSRect = msg_send![native, frameRectForContentRect: content];
        frame.origin.x = current.origin.x + (current.size.width - frame.size.width) / 2.0;
        frame.origin.y = current.origin.y + (current.size.height - frame.size.height) / 2.0;
        let screen: *const AnyObject = msg_send![native, screen];
        if let Some(screen) = screen.as_ref() {
            let visible: NSRect = msg_send![screen, visibleFrame];
            frame.size.width = frame.size.width.min(visible.size.width);
            frame.size.height = frame.size.height.min(visible.size.height);
            frame.origin.x = frame.origin.x.clamp(
                visible.origin.x,
                visible.origin.x + visible.size.width - frame.size.width,
            );
            frame.origin.y = frame.origin.y.clamp(
                visible.origin.y,
                visible.origin.y + visible.size.height - frame.size.height,
            );
        }
        // Raising the minimum before resizing creates an intermediate jump.
        let _: () = msg_send![native, setContentMinSize: NSSize::new(0.0, 0.0)];
        let actual: NSRect = msg_send![native, contentRectForFrameRect: frame];
        let minimum = NSSize::new(
            min_width.min(actual.size.width),
            min_height.min(actual.size.height),
        );
        let (sender, receiver) = tokio::sync::oneshot::channel();
        if !animate || current == frame {
            let _: () = msg_send![native, setFrame: frame, display: true];
            let _: () = msg_send![native, setContentMinSize: minimum];
            let _ = sender.send(());
            return Ok(receiver);
        }

        // NSWindow's setFrame:display:animate: runs its own synchronous loop.
        // That prevents the regular event loop from servicing WebKit paint
        // commits, so the loading dots trail the shrinking native frame.
        // An animation context returns immediately; report completion only
        // after AppKit finishes, while WebKit keeps processing frames.
        let retained = Retained::<AnyObject>::retain(pointer as *mut AnyObject)
            .ok_or_else(|| "The native window is unavailable.".to_string())?;
        let changes = block2::RcBlock::new(move |context: *mut AnyObject| {
            let _: () = msg_send![context, setDuration: 0.24_f64];
            let animator: *mut AnyObject = msg_send![native, animator];
            let _: () = msg_send![animator, setFrame: frame, display: true];
        });
        let sender = std::cell::RefCell::new(Some(sender));
        let completion = block2::RcBlock::new(move || {
            let _: () = msg_send![&*retained, setContentMinSize: minimum];
            if let Some(sender) = sender.borrow_mut().take() {
                let _ = sender.send(());
            }
        });
        let _: () = msg_send![class!(NSAnimationContext), runAnimationGroup: &*changes, completionHandler: &*completion];
        Ok(receiver)
    }
}
