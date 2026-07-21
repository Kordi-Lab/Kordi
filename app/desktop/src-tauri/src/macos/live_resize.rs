use std::cell::RefCell;
use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2_app_kit::{
    NSEvent, NSWindow, NSWindowDidEndLiveResizeNotification,
    NSWindowWillStartLiveResizeNotification,
};
use objc2_foundation::{
    NSDictionary, NSNotification, NSNotificationCenter, NSNumber, NSPoint, NSRect, NSString,
    NSUserDefaults, ns_string,
};
use tauri::{Emitter, Runtime, WebviewWindow};

const LIVE_RESIZE_START_EVENT: &str = "kordi-native-live-resize-start";
const LIVE_RESIZE_END_EVENT: &str = "kordi-native-live-resize-end";
const RESIZE_EDGE_SLOP: f64 = 18.0;

thread_local! {
    static OBSERVER_TOKENS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> =
        const { RefCell::new(Vec::new()) };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResizeDirection {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl ResizeDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::TopLeft => "top-left",
            Self::TopRight => "top-right",
            Self::BottomLeft => "bottom-left",
            Self::BottomRight => "bottom-right",
        }
    }
}

fn infer_resize_direction(frame: NSRect, cursor: NSPoint) -> ResizeDirection {
    let min_x = frame.origin.x;
    let max_x = frame.origin.x + frame.size.width;
    let min_y = frame.origin.y;
    let max_y = frame.origin.y + frame.size.height;
    let left = (cursor.x - min_x).abs();
    let right = (max_x - cursor.x).abs();
    let bottom = (cursor.y - min_y).abs();
    let top = (max_y - cursor.y).abs();

    let horizontal = if left.min(right) <= RESIZE_EDGE_SLOP {
        Some(if left <= right {
            ResizeDirection::Left
        } else {
            ResizeDirection::Right
        })
    } else {
        None
    };
    let vertical = if bottom.min(top) <= RESIZE_EDGE_SLOP {
        Some(if bottom <= top {
            ResizeDirection::Bottom
        } else {
            ResizeDirection::Top
        })
    } else {
        None
    };

    match (horizontal, vertical) {
        (Some(ResizeDirection::Left), Some(ResizeDirection::Top)) => ResizeDirection::TopLeft,
        (Some(ResizeDirection::Right), Some(ResizeDirection::Top)) => ResizeDirection::TopRight,
        (Some(ResizeDirection::Left), Some(ResizeDirection::Bottom)) => ResizeDirection::BottomLeft,
        (Some(ResizeDirection::Right), Some(ResizeDirection::Bottom)) => {
            ResizeDirection::BottomRight
        }
        (Some(direction), None) | (None, Some(direction)) => direction,
        (None, None) => {
            let closest_horizontal = if left <= right {
                (left, ResizeDirection::Left)
            } else {
                (right, ResizeDirection::Right)
            };
            let closest_vertical = if bottom <= top {
                (bottom, ResizeDirection::Bottom)
            } else {
                (top, ResizeDirection::Top)
            };
            if closest_horizontal.0 <= closest_vertical.0 {
                closest_horizontal.1
            } else {
                closest_vertical.1
            }
        }
        _ => unreachable!("axis directions are normalized before corner mapping"),
    }
}

fn retain_observer(token: Retained<ProtocolObject<dyn NSObjectProtocol>>) {
    OBSERVER_TOKENS.with(|tokens| tokens.borrow_mut().push(token));
}

pub fn configure_webkit_resize_geometry() {
    // WebKit's default remote layer tree acknowledges viewport geometry
    // asynchronously and coalesces later sizes while a reply is pending. That
    // can expose a previous frame when the top or left window edge moves. The
    // tiled Core Animation drawing area keeps geometry and presentation in one
    // synchronous resize transaction. Registering this fallback before Tauri
    // creates WKWebView selects that path without writing persistent defaults.
    let disabled: Retained<AnyObject> = NSNumber::numberWithBool(false)
        .into_super()
        .into_super()
        .into_super();
    let remote_layer_tree_default = ns_string!("WebKit2UseRemoteLayerTreeDrawingArea");
    let registration = NSDictionary::<NSString, AnyObject>::from_retained_objects(
        &[remote_layer_tree_default],
        &[disabled],
    );
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&registration) };
}

pub fn install<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let event_window = window.clone();
    window.with_webview(move |platform_webview| {
        // Tauri guarantees this closure runs on AppKit's main thread and that
        // this pointer refers to the live NSWindow instance.
        let window_ptr = platform_webview.ns_window() as usize;
        let window_object = unsafe { &*platform_webview.ns_window().cast::<AnyObject>() };
        let direction = Rc::new(RefCell::new(None::<ResizeDirection>));
        let center = NSNotificationCenter::defaultCenter();

        let start_direction = Rc::clone(&direction);
        let start_window = event_window.clone();
        let start_block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            if start_direction.borrow().is_some() {
                return;
            }
            let window = unsafe { &*(window_ptr as *const NSWindow) };
            let next_direction = infer_resize_direction(window.frame(), NSEvent::mouseLocation());
            *start_direction.borrow_mut() = Some(next_direction);
            if let Err(error) = start_window.emit(LIVE_RESIZE_START_EVENT, next_direction.as_str())
            {
                eprintln!("[kordi] Unable to emit live resize start: {error}");
            }
        });
        let start_token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowWillStartLiveResizeNotification),
                Some(window_object),
                None,
                &start_block,
            )
        };
        retain_observer(start_token);

        let end_direction = direction;
        let end_window = event_window;
        let end_block = RcBlock::new(move |_notification: NonNull<NSNotification>| {
            let Some(previous_direction) = end_direction.borrow_mut().take() else {
                return;
            };
            if let Err(error) = end_window.emit(LIVE_RESIZE_END_EVENT, previous_direction.as_str())
            {
                eprintln!("[kordi] Unable to emit live resize end: {error}");
            }
        });
        let end_token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidEndLiveResizeNotification),
                Some(window_object),
                None,
                &end_block,
            )
        };
        retain_observer(end_token);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> NSRect {
        NSRect::new(
            NSPoint::new(100.0, 200.0),
            objc2_foundation::NSSize::new(800.0, 600.0),
        )
    }

    #[test]
    fn detects_top_right_resize() {
        assert_eq!(
            infer_resize_direction(frame(), NSPoint::new(899.0, 799.0)),
            ResizeDirection::TopRight,
        );
    }

    #[test]
    fn detects_each_resize_edge_and_corner() {
        let cases = [
            (NSPoint::new(100.0, 500.0), ResizeDirection::Left),
            (NSPoint::new(900.0, 500.0), ResizeDirection::Right),
            (NSPoint::new(500.0, 800.0), ResizeDirection::Top),
            (NSPoint::new(500.0, 200.0), ResizeDirection::Bottom),
            (NSPoint::new(100.0, 800.0), ResizeDirection::TopLeft),
            (NSPoint::new(900.0, 800.0), ResizeDirection::TopRight),
            (NSPoint::new(100.0, 200.0), ResizeDirection::BottomLeft),
            (NSPoint::new(900.0, 200.0), ResizeDirection::BottomRight),
        ];

        for (cursor, expected_direction) in cases {
            assert_eq!(infer_resize_direction(frame(), cursor), expected_direction);
        }
    }
}
