use std::cell::{Cell, RefCell};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_core_location::{
    CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use tokio::sync::oneshot;

use super::LocationFix;

type Reply = Result<LocationFix, String>;
static REQUEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const DENIED: &str = "Allow Kordi to use Location Services in System Settings, then try again.";

#[derive(Default)]
struct LocationIvars {
    reply: RefCell<Option<oneshot::Sender<Reply>>>,
    started: Cell<bool>,
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
            if let Some(location) = locations.lastObject() {
                // Access is confined to the main run loop that owns the manager.
                let fix = unsafe {
                    let coordinate = location.coordinate();
                    LocationFix {
                        latitude: coordinate.latitude,
                        longitude: coordinate.longitude,
                        accuracy: location.horizontalAccuracy(),
                        timestamp: location.timestamp().timeIntervalSince1970() * 1000.0,
                    }
                };
                self.finish(manager, Ok(fix));
            }
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn failed(&self, manager: &CLLocationManager, _error: &NSError) {
            let message = if unsafe { manager.authorizationStatus() }
                == CLAuthorizationStatus::Denied
            {
                DENIED
            } else {
                "Could not find your location. Check Location Services and Wi-Fi, then try again."
            };
            self.finish(manager, Err(message.into()));
        }
    }
);

impl NearbyLocationDelegate {
    fn authorized(&self, manager: &CLLocationManager) {
        match unsafe { manager.authorizationStatus() } {
            CLAuthorizationStatus::NotDetermined
            | CLAuthorizationStatus::AuthorizedAlways
            | CLAuthorizationStatus::AuthorizedWhenInUse => {
                if !self.ivars().started.replace(true) {
                    // macOS prompts when a location service starts, including first use.
                    unsafe { manager.requestLocation() };
                }
            }
            CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => {
                self.finish(manager, Err(DENIED.into()));
            }
            _ => {}
        }
    }

    fn finish(&self, manager: &CLLocationManager, reply: Reply) {
        unsafe { manager.stopUpdatingLocation() };
        if let Some(sender) = self.ivars().reply.borrow_mut().take() {
            let _ = sender.send(reply);
        }
    }
}

struct ActiveRequest {
    manager: Retained<CLLocationManager>,
    // CLLocationManager's delegate is weak; keep it alive through completion or timeout.
    _delegate: Retained<NearbyLocationDelegate>,
}

thread_local! {
    static ACTIVE: RefCell<Option<ActiveRequest>> = const { RefCell::new(None) };
}

pub(super) async fn request(app: tauri::AppHandle) -> Reply {
    let _guard = REQUEST
        .try_lock()
        .map_err(|_| "A location request is already in progress.")?;
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = sender.send(Err("Could not start Location Services.".into()));
            return;
        };
        // Core Location and its delegate stay on the application's main run loop.
        unsafe {
            let delegate = NearbyLocationDelegate::alloc(mtm).set_ivars(LocationIvars {
                reply: RefCell::new(Some(sender)),
                started: Cell::new(false),
            });
            let delegate: Retained<NearbyLocationDelegate> = msg_send![super(delegate), init];
            let manager = CLLocationManager::new();
            manager.setDesiredAccuracy(100.0);
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            if !CLLocationManager::locationServicesEnabled_class() {
                delegate.finish(
                    &manager,
                    Err("Turn on Location Services in System Settings, then try again.".into()),
                );
            } else {
                delegate.authorized(&manager);
            }
            ACTIVE.with(|active| {
                *active.borrow_mut() = Some(ActiveRequest {
                    manager,
                    _delegate: delegate,
                })
            });
        }
    })
    .map_err(|_| "Could not start Location Services.")?;
    let result = match tokio::time::timeout(Duration::from_secs(30), receiver).await {
        Ok(Ok(reply)) => reply,
        _ => Err("Finding your location timed out. Check Location Services and try again.".into()),
    };
    let (stopped, done) = oneshot::channel();
    app.run_on_main_thread(move || {
        ACTIVE.with(|active| {
            if let Some(request) = active.borrow_mut().take() {
                unsafe {
                    request.manager.stopUpdatingLocation();
                    request.manager.setDelegate(None);
                }
            }
        });
        let _ = stopped.send(());
    })
    .map_err(|_| "Could not finish the location request.")?;
    let _ = done.await;
    result
}

pub(super) async fn permission(app: tauri::AppHandle) -> Result<String, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let status = unsafe {
            if !CLLocationManager::locationServicesEnabled_class() {
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
