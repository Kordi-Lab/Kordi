//! One foreground location fix, requested by the Nearby screen. Never logs coordinates.
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationFix {
    latitude: f64,
    longitude: f64,
    accuracy: f64,
    timestamp: f64,
}

/// Stable failure codes; the web view maps them to copy.
pub(crate) mod failure {
    /// Location access was denied or is restricted for this app.
    pub const DENIED: &str = "location_denied";
    /// Location Services are turned off for the whole Mac.
    pub const SERVICES_OFF: &str = "location_services_off";
    /// The process has no bundle identity, so macOS cannot ask for permission.
    pub const NOT_BUNDLED: &str = "location_not_bundled";
    /// The permission prompt was not answered in time.
    pub const PERMISSION_PENDING: &str = "location_permission_pending";
    /// No usable fix arrived in time.
    pub const TIMEOUT: &str = "location_timeout";
    /// Core Location reported an error other than denial.
    pub const UNAVAILABLE: &str = "location_unavailable";
    /// Another request is still running.
    pub const BUSY: &str = "location_busy";
}

/// Fixes coarser than this are not published; matches the web-side check.
const MAX_ACCURACY_METERS: f64 = 2000.0;
/// Core Location may first replay a cached fix; older ones are skipped.
const MAX_FIX_AGE_SECONDS: f64 = 300.0;

/// Whether a reported fix can be returned right away.
pub(crate) fn usable_fix(accuracy: f64, age_seconds: f64) -> bool {
    accuracy.is_finite()
        && (0.0..=MAX_ACCURACY_METERS).contains(&accuracy)
        && age_seconds.is_finite()
        && age_seconds <= MAX_FIX_AGE_SECONDS
}

/// What a Core Location error means for a pending request. `None` keeps waiting.
pub(crate) fn failure_for_error_code(code: isize) -> Option<&'static str> {
    // kCLErrorLocationUnknown: Core Location keeps trying; the error is transient.
    const LOCATION_UNKNOWN: isize = 0;
    // kCLErrorDenied
    const DENIED: isize = 1;
    match code {
        LOCATION_UNKNOWN => None,
        DENIED => Some(failure::DENIED),
        _ => Some(failure::UNAVAILABLE),
    }
}

#[cfg(target_os = "macos")]
mod macos;

#[tauri::command]
pub async fn desktop_nearby_location(app: tauri::AppHandle) -> Result<LocationFix, String> {
    #[cfg(target_os = "macos")]
    {
        match macos::request(app, true).await {
            Ok(Some(fix)) => Ok(fix),
            Ok(None) => Err(failure::UNAVAILABLE.into()),
            Err(code) => Err(code.into()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(failure::UNAVAILABLE.into())
    }
}

/// Permission setup does not publish a location or enable Nearby.
#[tauri::command]
pub async fn desktop_nearby_location_permission(
    app: tauri::AppHandle,
    request: bool,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let status = macos::permission(app.clone()).await?;
        if request && status == "not_determined" {
            // Only asks for access; no location is read here.
            let result = macos::request(app.clone(), false).await;
            let status = macos::permission(app).await?;
            if status == "not_determined" {
                result.map_err(String::from)?;
            }
            Ok(status)
        } else {
            Ok(status)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok("unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usable_fix_requires_fresh_and_precise_readings() {
        assert!(usable_fix(65.0, 1.0));
        assert!(usable_fix(2000.0, 300.0));
        assert!(
            !usable_fix(-1.0, 1.0),
            "negative accuracy marks an invalid fix"
        );
        assert!(!usable_fix(2000.5, 1.0));
        assert!(!usable_fix(50.0, 301.0), "cached fixes are skipped");
        assert!(!usable_fix(f64::NAN, 1.0));
    }

    #[test]
    fn core_location_errors_map_to_stable_codes() {
        assert_eq!(failure_for_error_code(0), None);
        assert_eq!(failure_for_error_code(1), Some(failure::DENIED));
        assert_eq!(failure_for_error_code(2), Some(failure::UNAVAILABLE));
    }
}
