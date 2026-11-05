//! Window geometry for the sign-in gate: where the detached web view sits
//! relative to the visible window area, and the window frames each surface
//! uses on screen.

use super::AuthWindowCrop;

/// A rectangle in a window's base coordinates: origin at the bottom left,
/// y growing upward, in points.
#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct WindowRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(any(target_os = "macos", test))]
impl WindowRect {
    pub(super) fn top(self) -> f64 {
        self.y + self.height
    }

    /// A rectangle of the given size centered on this one, on whole points.
    pub(super) fn centered(self, width: f64, height: f64) -> Self {
        Self {
            x: self.x + ((self.width - width) / 2.0).round(),
            y: self.y + ((self.height - height) / 2.0).round(),
            width,
            height,
        }
    }
}

/// The crop the page needs to place its gate screens: how far the web view
/// reaches past the visible area's left and top edges, and that area's size.
/// Both rectangles are measured in the same window coordinates, so where the
/// web view's superview sits in the window does not matter.
#[cfg(any(target_os = "macos", test))]
pub(super) fn crop_between(webview: WindowRect, visible: WindowRect) -> AuthWindowCrop {
    AuthWindowCrop {
        x: (visible.x - webview.x).max(0.0),
        y: (webview.top() - visible.top()).max(0.0),
        width: visible.width,
        height: visible.height,
    }
}

#[cfg(target_os = "macos")]
pub(super) mod native {
    use super::WindowRect;
    use crate::auth_window::AuthWindowSurface;
    use objc2::{class, msg_send, runtime::AnyObject};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    pub(in crate::auth_window) fn window_rect(rect: NSRect) -> WindowRect {
        WindowRect {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    pub(in crate::auth_window) fn ns_rect(rect: WindowRect) -> NSRect {
        NSRect::new(
            NSPoint::new(rect.x, rect.y),
            NSSize::new(rect.width, rect.height),
        )
    }

    /// Fits `frame` inside a screen's visible area.
    fn clamp_to(mut frame: NSRect, visible: NSRect) -> NSRect {
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
        frame
    }

    /// Centers `current`'s replacement for a content size, clamped to the screen.
    pub(in crate::auth_window) unsafe fn clamped_frame(
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
        match screen.as_ref() {
            Some(screen) => clamp_to(frame, msg_send![screen, visibleFrame]),
            None => frame,
        }
    }

    /// The remembered main frame on a screen that still shows part of it.
    pub(in crate::auth_window) unsafe fn remembered_frame(saved: NSRect) -> Option<NSRect> {
        let screens: *const AnyObject = msg_send![class!(NSScreen), screens];
        let screens = screens.as_ref()?;
        let count: usize = msg_send![screens, count];
        (0..count).find_map(|index| {
            let screen: *const AnyObject = msg_send![screens, objectAtIndex: index];
            let screen = screen.as_ref()?;
            let visible: NSRect = msg_send![screen, visibleFrame];
            let overlaps = saved.origin.x < visible.origin.x + visible.size.width
                && visible.origin.x < saved.origin.x + saved.size.width
                && saved.origin.y < visible.origin.y + visible.size.height
                && visible.origin.y < saved.origin.y + saved.size.height;
            overlaps.then(|| clamp_to(saved, visible))
        })
    }

    /// Gates hide the workspace pane backings, which only fit the main shell.
    /// The welcome window uses the lighter HUD material and keeps it active so
    /// the blur stays while the browser has focus; other surfaces use the
    /// configured sidebar material and follow the window's active state.
    pub(in crate::auth_window) unsafe fn prepare_backdrop(
        parent: &AnyObject,
        surface: AuthWindowSurface,
    ) {
        let welcome = surface == AuthWindowSurface::Welcome;
        // NSVisualEffectMaterialHUDWindow = 13, Sidebar = 7.
        let material: isize = if welcome { 13 } else { 7 };
        // NSVisualEffectStateFollowsWindowActiveState = 0, Active = 1.
        let material_state = isize::from(welcome);
        let gate = surface != AuthWindowSurface::Main;
        let backings = [
            NSString::from_str("kordi-session-backing"),
            NSString::from_str("kordi-workspace-backing"),
        ];
        let views: *const AnyObject = msg_send![parent, subviews];
        let Some(views) = views.as_ref() else {
            return;
        };
        let count: usize = msg_send![views, count];
        for index in 0..count {
            let child: *const AnyObject = msg_send![views, objectAtIndex: index];
            let Some(child) = child.as_ref() else {
                continue;
            };
            let is_material: bool = msg_send![child, isKindOfClass: class!(NSVisualEffectView)];
            if is_material {
                let _: () = msg_send![child, setMaterial: material];
                let _: () = msg_send![child, setState: material_state];
                continue;
            }
            let identifier: *const AnyObject = msg_send![child, identifier];
            let Some(identifier) = identifier.as_ref() else {
                continue;
            };
            let is_backing = backings
                .iter()
                .any(|name| -> bool { msg_send![identifier, isEqualToString: &**name] });
            if is_backing {
                let frame: NSRect = msg_send![child, frame];
                let hidden = gate || frame.size.width <= 0.0;
                let _: () = msg_send![child, setHidden: hidden];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{crop_between, WindowRect};
    use crate::auth_window::AuthWindowCrop;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> WindowRect {
        WindowRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_centered_web_view_reports_its_overhang_and_the_visible_size() {
        let visible = rect(0.0, 0.0, 440.0, 560.0);
        let webview = visible.centered(1480.0, 983.0);
        assert_eq!(webview, rect(-520.0, -212.0, 1480.0, 983.0));
        // 983 - 560 is odd: the extra point falls above the window.
        assert_eq!(
            crop_between(webview, visible),
            AuthWindowCrop {
                x: 520.0,
                y: 211.0,
                width: 440.0,
                height: 560.0
            }
        );
    }

    #[test]
    fn the_crop_follows_where_the_web_view_actually_sits() {
        // A web view 68 points higher than centered shows rows 280..840.
        let visible = rect(0.0, 0.0, 440.0, 560.0);
        let webview = rect(-520.0, -143.0, 1480.0, 983.0);
        let crop = crop_between(webview, visible);
        assert_eq!((crop.x, crop.y), (520.0, 280.0));
        assert_eq!(crop.y + crop.height + 143.0, webview.height);
    }

    #[test]
    fn centering_uses_the_visible_area_not_the_origin() {
        let visible = rect(100.0, 40.0, 440.0, 560.0);
        let webview = visible.centered(1480.0, 980.0);
        assert_eq!(webview, rect(-420.0, -170.0, 1480.0, 980.0));
        let crop = crop_between(webview, visible);
        assert_eq!((crop.x, crop.y), (520.0, 210.0));
    }

    #[test]
    fn a_web_view_inside_the_window_has_no_crop() {
        let visible = rect(0.0, 0.0, 1480.0, 980.0);
        assert_eq!(
            crop_between(visible, visible),
            AuthWindowCrop {
                x: 0.0,
                y: 0.0,
                width: 1480.0,
                height: 980.0
            }
        );
    }
}
