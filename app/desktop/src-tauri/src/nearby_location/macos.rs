use std::cell::{Cell, RefCell};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_core_location::{
    CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate,
};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol};
use tokio::sync::oneshot;

use super::{failure, failure_for_error_code, usable_fix, LocationFix};

/// `None` when the request only asked for permission.
type Reply = Result<Option<LocationFix>, &'static str>;
static REQUEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Time for the person to answer the macOS permission prompt.
const PERMISSION_WAIT: Duration = Duration::from_secs(120);
/// Time for a fix once access is granted.
const FIX_WAIT: Duration = Duration::from_secs(30);

struct LocationIvars {
    reply: RefCell<Option<oneshot::Sender<Reply>>>,
    /// Signalled once access is granted; dropped when the request ends early.
    granted: RefCell<Option<oneshot::Sender<()>>>,
    fetch: bool,
    asked: Cell<bool>,
    started: Cell<bool>,
    /// Best fresh but coarse fix, returned if nothing better arrives in time.
    best: RefCell<Option<LocationFix>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = LocationIvars]
    struct NearbyLocationDelegate;

    unsafe impl NSObjectProtocol for NearbyLocationDelegate {}

    unsafe impl CLLocationManagerDelegate for NearbyLocationDelegate {
        #[unsafe(method(locationManagerDidChangeAuthorization:))]
        fn authorization_changed(&self, manager: &CLLocationManager) {
            self.authorized(manager);
        }

        #[unsafe(method(locationManager:didUpdateLocations:))]
        fn received(&self, manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
            for location in locations.iter() {
                // Access is confined to the main run loop that owns the manager.
                let (fix, age) = unsafe {
                    let coordinate = location.coordinate();
                    let timestamp = location.timestamp();
                    (
                        LocationFix {
                            latitude: coordinate.latitude,
                            longitude: coordinate.longitude,
                            accuracy: location.horizontalAccuracy(),
                            timestamp: timestamp.timeIntervalSince1970() * 1000.0,
                        },
                        -timestamp.timeIntervalSinceNow(),
                    )
                };
                if usable_fix(fix.accuracy, age) {
                    self.finish(manager, Ok(Some(fix)));
                    return;
                }
                if fix.accuracy >= 0.0 && usable_fix(0.0, age) {
                    let mut best = self.ivars().best.borrow_mut();
                    if best
                        .as_ref()
                        .is_none_or(|best| fix.accuracy < best.accuracy)
                    {
                        *best = Some(fix);
                    }
                }
            }
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn failed(&self, manager: &CLLocationManager, error: &NSError) {
            if let Some(code) = failure_for_error_code(error.code()) {
                self.finish(manager, Err(code));
            }
        }
    }
);

impl NearbyLocationDelegate {
    fn authorized(&self, manager: &CLLocationManager) {
        match unsafe { manager.authorizationStatus() } {
            CLAuthorizationStatus::NotDetermined => {
                if !self.ivars().asked.replace(true) {
                    // Shows the macOS prompt; the answer arrives through this delegate.
                    unsafe { manager.requestWhenInUseAuthorization() };
                }
            }
            CLAuthorizationStatus::AuthorizedAlways
            | CLAuthorizationStatus::AuthorizedWhenInUse => {
                if let Some(granted) = self.ivars().granted.borrow_mut().take() {
                    let _ = granted.send(());
                }
                if !self.ivars().fetch {
                    self.finish(manager, Ok(None));
                } else if !self.ivars().started.replace(true) {
                    unsafe { manager.startUpdatingLocation() };
                }
            }
            CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => {
                self.finish(manager, Err(failure::DENIED));
            }
            _ => {}
        }
    }

    fn finish(&self, manager: &CLLocationManager, reply: Reply) {
        unsafe { manager.stopUpdatingLocation() };
        self.ivars().granted.borrow_mut().take();
        if let Some(sender) = self.ivars().reply.borrow_mut().take() {
            let _ = sender.send(reply);
        }
    }
}

struct ActiveRequest {
    manager: Retained<CLLocationManager>,
    // CLLocationManager's delegate is weak; keep it alive through completion or timeout.
    delegate: Retained<NearbyLocationDelegate>,
}

thread_local! {
    static ACTIVE: RefCell<Option<ActiveRequest>> = const { RefCell::new(None) };
}

/// macOS only shows the location prompt to a process with a bundle identity.
fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// Asks for access when needed, then, with `fetch`, reads one foreground fix.
pub(super) async fn request(app: tauri::AppHandle, fetch: bool) -> Reply {
    let _guard = REQUEST.try_lock().map_err(|_| failure::BUSY)?;
    let (sender, receiver) = oneshot::channel();
    let (granted, granted_receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = sender.send(Err(failure::UNAVAILABLE));
            return;
        };
        if !bundled() {
            let _ = sender.send(Err(failure::NOT_BUNDLED));
            return;
        }
        // Core Location and its delegate stay on the application's main run loop.
        unsafe {
            let delegate = NearbyLocationDelegate::alloc(mtm).set_ivars(LocationIvars {
                reply: RefCell::new(Some(sender)),
                granted: RefCell::new(Some(granted)),
                fetch,
                asked: Cell::new(false),
                started: Cell::new(false),
                best: RefCell::new(None),
            });
            let delegate: Retained<NearbyLocationDelegate> = msg_send![super(delegate), init];
            let manager = CLLocationManager::new();
            manager.setDesiredAccuracy(100.0);
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            if !CLLocationManager::locationServicesEnabled_class() {
                delegate.finish(&manager, Err(failure::SERVICES_OFF));
            } else {
                delegate.authorized(&manager);
            }
            ACTIVE.with(|active| *active.borrow_mut() = Some(ActiveRequest { manager, delegate }));
        }
    })
    .map_err(|_| failure::UNAVAILABLE)?;
    // The grant sender is dropped when the request ends before access is granted.
    let result = match tokio::time::timeout(PERMISSION_WAIT, granted_receiver).await {
        Err(_) => Err(failure::PERMISSION_PENDING),
        Ok(_) => match tokio::time::timeout(FIX_WAIT, receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(failure::UNAVAILABLE),
            Err(_) => Err(failure::TIMEOUT),
        },
    };
    let (stopped, done) = oneshot::channel();
    app.run_on_main_thread(move || {
        let best = ACTIVE.with(|active| {
            active.borrow_mut().take().and_then(|request| {
                unsafe {
                    request.manager.stopUpdatingLocation();
                    request.manager.setDelegate(None);
                }
                request.delegate.ivars().best.borrow_mut().take()
            })
        });
        let _ = stopped.send(best);
    })
    .map_err(|_| failure::UNAVAILABLE)?;
    let best = done.await.ok().flatten();
    match result {
        // A coarse fix lets the caller explain the accuracy instead of a timeout.
        Err(failure::TIMEOUT) if best.is_some() => Ok(best),
        result => result,
    }
}

pub(super) async fn permission(app: tauri::AppHandle) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let status = unsafe {
            if !bundled() {
                "unavailable"
            } else if !CLLocationManager::locationServicesEnabled_class() {
                "denied"
            } else {
                match CLLocationManager::new().authorizationStatus() {
                    CLAuthorizationStatus::NotDetermined => "not_determined",
                    CLAuthorizationStatus::Denied => "denied",
                    CLAuthorizationStatus::Restricted => "restricted",
                    CLAuthorizationStatus::AuthorizedAlways
                    | CLAuthorizationStatus::AuthorizedWhenInUse => "granted",
                    _ => "unknown",
                }
            }
        };
        let _ = sender.send(status.to_string());
    })
    .map_err(|_| "Could not read location permission.")?;
    receiver
        .await
        .map_err(|_| "Could not read location permission.".into())
}
