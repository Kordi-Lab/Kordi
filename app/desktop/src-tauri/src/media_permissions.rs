//! Permission setup without starting a recording, camera session, or transcription.

#[derive(Clone, Copy)]
enum Source {
    Microphone,
    Camera,
    Speech,
}

impl Source {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "microphone" => Ok(Self::Microphone),
            "camera" => Ok(Self::Camera),
            "speech" => Ok(Self::Speech),
            _ => Err("Unknown media permission.".into()),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn status_label(status: isize) -> &'static str {
    match status {
        0 => "not_determined",
        1 => "restricted",
        2 => "denied",
        3 => "granted",
        _ => "unknown",
    }
}

#[cfg(target_os = "macos")]
fn access(source: Source, request: bool) -> Result<String, String> {
    use block2::StackBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use objc2_speech as _;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    objc2::rc::autoreleasepool(|_| unsafe {
        let media_type = NSString::from_str(match source {
            Source::Camera => "vide",
            _ => "soun",
        });
        let speech = matches!(source, Source::Speech);
        let status: isize = if speech {
            msg_send![class!(SFSpeechRecognizer), authorizationStatus]
        } else {
            msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*media_type]
        };
        // Speech uses denied=1, restricted=2; AVFoundation uses the reverse.
        let normalize = |value| match (speech, value) {
            (true, 1) => 2,
            (true, 2) => 1,
            _ => value,
        };
        if !request || status != 0 {
            return Ok(status_label(normalize(status)).into());
        }
        let result = Arc::new((Mutex::new(None), Condvar::new()));
        if speech {
            let callback = result.clone();
            let block = StackBlock::new(move |value: isize| {
                let (lock, ready) = &*callback;
                if let Ok(mut slot) = lock.lock() {
                    *slot = Some(value);
                    ready.notify_one();
                }
            })
            .copy();
            let _: () = msg_send![class!(SFSpeechRecognizer), requestAuthorization: &*block];
        } else {
            let callback = result.clone();
            let block = StackBlock::new(move |granted: Bool| {
                let (lock, ready) = &*callback;
                if let Ok(mut slot) = lock.lock() {
                    *slot = Some(if granted.as_bool() { 3 } else { 2 });
                    ready.notify_one();
                }
            })
            .copy();
            let _: () = msg_send![class!(AVCaptureDevice), requestAccessForMediaType: &*media_type, completionHandler: &*block];
        }
        let (lock, ready) = &*result;
        let guard = lock
            .lock()
            .map_err(|_| "Permission state is unavailable.".to_string())?;
        let next = ready
            .wait_timeout_while(guard, Duration::from_secs(60), |value| value.is_none())
            .map_err(|_| "Permission check failed.".to_string())?
            .0
            .take()
            .ok_or_else(|| {
                "Permission request timed out. Check again after answering the system prompt."
                    .to_string()
            })?;
        Ok(status_label(normalize(next)).into())
    })
}

#[tauri::command]
pub async fn desktop_media_permission(source: String, request: bool) -> Result<String, String> {
    let source = Source::parse(&source)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || access(source, request))
            .await
            .map_err(|_| "Permission check could not finish.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (source, request);
        Ok("unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_permissions() {
        assert!(Source::parse("screen").is_err());
        assert!(Source::parse("camera").is_ok());
    }

    #[test]
    fn permission_statuses_preserve_restrictions_and_unknown_values() {
        assert_eq!(status_label(0), "not_determined");
        assert_eq!(status_label(1), "restricted");
        assert_eq!(status_label(2), "denied");
        assert_eq!(status_label(3), "granted");
        assert_eq!(status_label(99), "unknown");
    }
}
