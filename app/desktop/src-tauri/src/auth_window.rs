use serde::{Deserialize, Serialize};

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

/// How far the web view extends past the window's left and top edges, in
/// logical points. The gate offsets its top-anchored chrome by this amount.
#[derive(Clone, Copy, Default, PartialEq, Serialize)]
pub(crate) struct AuthWindowCrop {
    x: f64,
    y: f64,
}

#[tauri::command]
pub(crate) async fn desktop_set_auth_window_surface(
    window: tauri::WebviewWindow,
    surface: AuthWindowSurface,
    animate: bool,
) -> Result<AuthWindowCrop, String> {
    if window.label() != super::window_lifecycle::MAIN_WINDOW_LABEL {
        return Err("Auth sizing is only available for the main window.".into());
    }
    if window.is_fullscreen().map_err(|err| err.to_string())? {
        return Ok(last_crop());
    }
    #[cfg(not(target_os = "macos"))]
    let (width, height, min_width, min_height) = surface.dimensions();

    #[cfg(target_os = "macos")]
    let crop = {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window
            .with_webview(move |webview| {
                let result = macos::resize(&target, webview.inner(), surface, animate);
                let _ = sender.send(result);
            })
            .map_err(|err| err.to_string())?;
        let animation = receiver
            .await
            .map_err(|_| "Window resize was interrupted.".to_string())??;
        animation
            .await
            .map_err(|_| "Window animation was interrupted.".to_string())?
    };
    #[cfg(not(target_os = "macos"))]
    let crop = {
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
        AuthWindowCrop::default()
    };
    window
        .set_resizable(matches!(surface, AuthWindowSurface::Main))
        .map_err(|err| err.to_string())?;
    Ok(crop)
}

#[cfg(not(target_os = "macos"))]
fn last_crop() -> AuthWindowCrop {
    AuthWindowCrop::default()
}

#[cfg(target_os = "macos")]
fn last_crop() -> AuthWindowCrop {
    macos::LAST_CROP
        .lock()
        .map(|crop| *crop)
        .unwrap_or_default()
}

// WKWebView commits layers asynchronously (WebKit bug 323132), so a web view
// that grows with an animating window exposes uncommitted strips at its right
// and bottom edges. During gate transitions the web view therefore keeps the
// main-window size and stays centered in the window; the centered gate looks
// the same when cropped. It rejoins autoresizing once the main shell is shown.
#[cfg(target_os = "macos")]
mod macos {
    use super::{AuthWindowCrop, AuthWindowSurface};
    use objc2::{
        class, ffi, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, Bool, Imp, Sel},
        sel,
    };
    use objc2_foundation::{
        NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString,
    };
    use std::{
        cell::{Cell, RefCell},
        ptr::NonNull,
        sync::{Mutex, OnceLock},
    };
    use tauri::Emitter;

    pub(super) static LAST_CROP: Mutex<AuthWindowCrop> =
        Mutex::new(AuthWindowCrop { x: 0.0, y: 0.0 });
    const CROP_EVENT: &str = "kordi://auth-window-crop";
    const WIDTH_AND_HEIGHT_SIZABLE: usize = (1 << 1) | (1 << 4);

    struct AuthWebviewState {
        detached: bool,
        webview: Retained<AnyObject>,
        window: Retained<AnyObject>,
        size: NSSize,
        observer: Retained<objc2::runtime::ProtocolObject<dyn NSObjectProtocol>>,
    }

    thread_local! {
        static STATE: RefCell<Option<AuthWebviewState>> = const { RefCell::new(None) };
        // Mirrors the detached web view so the hold override never needs a
        // STATE borrow, which may already be held when AppKit calls it.
        static DETACHED_WEBVIEW: Cell<*const AnyObject> = const { Cell::new(std::ptr::null()) };
    }

    // WebKit bug 323132: WKWebView's setFrameSize: asks the window to hold a
    // resize snapshot until WebKit's next presentation update. AppKit sends
    // that call on every animated window frame even to the detached web view,
    // so the window keeps showing its old image behind the moving frame. The
    // detached web view never resizes, so no uncommitted area can show and the
    // hold is skipped. During a live drag the hold makes the whole window image
    // trail the pointer with a see-through gap; without it the frame follows
    // the pointer and the native backing panes fill the strip for the frame or
    // two WebKit needs to commit. The selector is private; when it is missing
    // nothing is overridden and the hold stays as before.
    static ORIGINAL_HOLD: OnceLock<usize> = OnceLock::new();

    extern "C-unwind" fn hold_window_resize_snapshot(this: *mut AnyObject, cmd: Sel) -> Bool {
        let detached = DETACHED_WEBVIEW
            .try_with(|webview| !this.is_null() && webview.get() == this.cast_const())
            .unwrap_or(false);
        // SAFETY: `this` is a live WKWebView; both selectors are public AppKit.
        let live_resize = !this.is_null()
            && unsafe {
                let window: *mut AnyObject = msg_send![this, window];
                !window.is_null() && msg_send![window, inLiveResize]
            };
        if detached || live_resize {
            return Bool::NO;
        }
        let Some(&original) = ORIGINAL_HOLD.get() else {
            return Bool::NO;
        };
        // SAFETY: `original` is the IMP previously registered for this
        // selector, whose signature is BOOL (id, SEL).
        let original: extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool =
            unsafe { std::mem::transmute::<usize, _>(original) };
        original(this, cmd)
    }

    /// Installs the hold override on the web view's class once per process.
    unsafe fn override_resize_snapshot_hold(webview: *mut AnyObject) {
        static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if INSTALLED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let selector = sel!(_holdWindowResizeSnapshotIfNeeded);
        let Some(base) = AnyClass::get(c"WKWebView") else {
            return;
        };
        if ffi::class_getInstanceMethod(base, selector).is_null() {
            return;
        }
        let class = ffi::object_getClass(webview) as *mut AnyClass;
        if class.is_null() {
            return;
        }
        let replacement: extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool =
            hold_window_resize_snapshot;
        let replacement: Imp = std::mem::transmute(replacement);
        let inherited = ffi::class_getInstanceMethod(ffi::class_getSuperclass(class), selector);
        let inherited = if inherited.is_null() {
            None
        } else {
            ffi::method_getImplementation(inherited)
        };
        if ffi::class_addMethod(class, selector, replacement, c"B@:".as_ptr()).as_bool() {
            if let Some(imp) = inherited {
                let _ = ORIGINAL_HOLD.set(imp as usize);
            }
            return;
        }
        // The class implements the selector itself; swap its implementation.
        let existing = ffi::class_getInstanceMethod(class, selector);
        if existing.is_null() {
            return;
        }
        if let Some(imp) = ffi::method_setImplementation(existing, replacement) {
            let _ = ORIGINAL_HOLD.set(imp as usize);
        }
    }

    fn publish(window: &tauri::WebviewWindow, crop: AuthWindowCrop) {
        if let Ok(mut last) = LAST_CROP.lock() {
            *last = crop;
        }
        let _ = window.emit(CROP_EVENT, crop);
    }

    /// Centers `webview` in `parent` without changing its size.
    unsafe fn center(webview: &AnyObject, parent: &AnyObject) -> AuthWindowCrop {
        let bounds: NSRect = msg_send![parent, bounds];
        let frame: NSRect = msg_send![webview, frame];
        let offset_x = ((bounds.size.width - frame.size.width) / 2.0).round();
        let offset_y = ((bounds.size.height - frame.size.height) / 2.0).round();
        let origin = NSPoint::new(bounds.origin.x + offset_x, bounds.origin.y + offset_y);
        if origin != frame.origin {
            let _: () = msg_send![webview, setFrameOrigin: origin];
        }
        AuthWindowCrop {
            x: (-offset_x).max(0.0),
            y: (-offset_y).max(0.0),
        }
    }

    /// Returns the web view to window-sized autoresizing.
    unsafe fn reattach(webview: &AnyObject, parent: &AnyObject) {
        STATE.with(|cell| {
            if let Some(state) = cell.borrow_mut().as_mut() {
                state.detached = false;
            }
        });
        DETACHED_WEBVIEW.set(std::ptr::null());
        let _: () = msg_send![webview, setAutoresizingMask: WIDTH_AND_HEIGHT_SIZABLE];
        let bounds: NSRect = msg_send![parent, bounds];
        let _: () = msg_send![webview, setFrame: bounds];
    }

    unsafe fn on_window_resize(window: &tauri::WebviewWindow) {
        let Some(webview) = STATE.with(|cell| {
            let Ok(mut state) = cell.try_borrow_mut() else {
                return None;
            };
            let state = state.as_mut().filter(|state| state.detached)?;
            let parent: *const AnyObject = msg_send![&*state.webview, superview];
            let parent = parent.as_ref()?;
            let bounds: NSRect = msg_send![parent, bounds];
            // Full screen or a larger display can outgrow the main size.
            let size = NSSize::new(
                state.size.width.max(bounds.size.width),
                state.size.height.max(bounds.size.height),
            );
            if size != state.size {
                state.size = size;
                let _: () = msg_send![&*state.webview, setFrameSize: size];
            }
            Some(state.webview.clone())
        }) else {
            return;
        };
        let parent: *const AnyObject = msg_send![&*webview, superview];
        if let Some(parent) = parent.as_ref() {
            publish(window, center(&webview, parent));
        }
    }

    /// Records the native views and installs the resize observer once.
    unsafe fn ensure_state(
        window: &tauri::WebviewWindow,
        native: *mut AnyObject,
        webview: *mut AnyObject,
    ) -> Result<(), String> {
        let current = STATE.with(|cell| {
            cell.borrow().as_ref().is_some_and(|state| {
                Retained::as_ptr(&state.window) == native.cast_const()
                    && Retained::as_ptr(&state.webview) == webview.cast_const()
            })
        });
        if current {
            return Ok(());
        }
        let unavailable = || "The native window is unavailable.".to_string();
        let retained_window = Retained::retain(native).ok_or_else(unavailable)?;
        let retained_webview = Retained::retain(webview).ok_or_else(unavailable)?;
        let frame: NSRect = msg_send![&*retained_webview, frame];
        let center = NSNotificationCenter::defaultCenter();
        let target = window.clone();
        let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
            on_window_resize(&target);
        });
        let observer = center.addObserverForName_object_queue_usingBlock(
            Some(&NSString::from_str("NSWindowDidResizeNotification")),
            Some(&*retained_window),
            None,
            &block,
        );
        override_resize_snapshot_hold(webview);
        DETACHED_WEBVIEW.set(std::ptr::null());
        let previous = STATE.with(|cell| {
            cell.borrow_mut().replace(AuthWebviewState {
                detached: false,
                webview: retained_webview,
                window: retained_window,
                size: frame.size,
                observer,
            })
        });
        if let Some(previous) = previous {
            let observer: &AnyObject = (*previous.observer).as_ref();
            center.removeObserver(observer);
        }
        Ok(())
    }

    /// Centers `current`'s replacement for a content size, clamped to the screen.
    unsafe fn clamped_frame(
        native: &AnyObject,
        current: NSRect,
        width: f64,
        height: f64,
    ) -> NSRect {
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
        frame
    }

    pub(super) fn resize(
        window: &tauri::WebviewWindow,
        webview_pointer: *mut std::ffi::c_void,
        surface: AuthWindowSurface,
        animate: bool,
    ) -> Result<tokio::sync::oneshot::Receiver<AuthWindowCrop>, String> {
        let pointer = window.ns_window().map_err(|err| err.to_string())?;
        let (width, height, min_width, min_height) = surface.dimensions();
        let (main_width, main_height, _, _) = AuthWindowSurface::Main.dimensions();
        let gate = !matches!(surface, AuthWindowSurface::Main);
        // SAFETY: Tauri owns this NSWindow and its WKWebView for the duration
        // of the main-thread closure, and the retained copies keep both alive
        // for the observer and completion blocks. All selectors are public
        // AppKit APIs. No state borrow is held across a window frame change,
        // because the resize observer runs synchronously inside it.
        unsafe {
            let native = (pointer as *const AnyObject)
                .as_ref()
                .ok_or_else(|| "The native window is unavailable.".to_string())?;
            let webview = Retained::retain(webview_pointer as *mut AnyObject)
                .ok_or_else(|| "The native webview is unavailable.".to_string())?;
            let parent: *const AnyObject = msg_send![&*webview, superview];
            let parent = Retained::retain(parent as *mut AnyObject)
                .ok_or_else(|| "The native webview is unavailable.".to_string())?;
            ensure_state(
                window,
                pointer as *mut AnyObject,
                Retained::as_ptr(&webview) as *mut AnyObject,
            )?;

            let current: NSRect = msg_send![native, frame];
            let frame = clamped_frame(native, current, width, height);
            let detached =
                STATE.with(|cell| cell.borrow().as_ref().is_some_and(|state| state.detached));
            if gate {
                if !detached {
                    let main_frame = clamped_frame(native, current, main_width, main_height);
                    let gate_size: NSRect = msg_send![native, contentRectForFrameRect: main_frame];
                    let present: NSRect = msg_send![&*webview, frame];
                    let size = NSSize::new(
                        present.size.width.max(gate_size.size.width),
                        present.size.height.max(gate_size.size.height),
                    );
                    let _: () = msg_send![&*webview, setAutoresizingMask: 0_usize];
                    if size != present.size {
                        let _: () = msg_send![&*webview, setFrameSize: size];
                    }
                    STATE.with(|cell| {
                        if let Some(state) = cell.borrow_mut().as_mut() {
                            state.detached = true;
                            state.size = size;
                        }
                    });
                    DETACHED_WEBVIEW.set(Retained::as_ptr(&webview));
                }
                center(&webview, &parent);
            } else if !detached {
                reattach(&webview, &parent);
            }

            // Raising the minimum before resizing creates an intermediate jump.
            let _: () = msg_send![native, setContentMinSize: NSSize::new(0.0, 0.0)];
            let actual: NSRect = msg_send![native, contentRectForFrameRect: frame];
            let minimum = NSSize::new(
                min_width.min(actual.size.width),
                min_height.min(actual.size.height),
            );
            let target = window.clone();
            let finish = move || {
                let crop = if gate {
                    center(&webview, &parent)
                } else {
                    reattach(&webview, &parent);
                    AuthWindowCrop::default()
                };
                publish(&target, crop);
                crop
            };
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if !animate || current == frame {
                let _: () = msg_send![native, setFrame: frame, display: true];
                let _: () = msg_send![native, setContentMinSize: minimum];
                let _ = sender.send(finish());
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
            let sender = RefCell::new(Some(sender));
            let completion = block2::RcBlock::new(move || {
                let _: () = msg_send![&*retained, setContentMinSize: minimum];
                if let Some(sender) = sender.borrow_mut().take() {
                    let _ = sender.send(finish());
                }
            });
            let _: () = msg_send![class!(NSAnimationContext), runAnimationGroup: &*changes, completionHandler: &*completion];
            Ok(receiver)
        }
    }
}
