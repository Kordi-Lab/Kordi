use block2::StackBlock;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use objc2_speech as _;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::super::{normalized_locale, voice_trim_range};

fn authorized() -> Result<(), String> {
    unsafe {
        let status: isize = msg_send![class!(SFSpeechRecognizer), authorizationStatus];
        match status {
            3 => return Ok(()),
            1 | 2 => {
                return Err(
                    "Allow Kordi to use Speech Recognition in System Settings and try again."
                        .to_string(),
                )
            }
            _ => {}
        }

        let result = Arc::new((Mutex::new(None), Condvar::new()));
        let callback_result = result.clone();
        let block = StackBlock::new(move |next_status: isize| {
            let (lock, ready) = &*callback_result;
            *lock.lock().expect("speech authorization state poisoned") = Some(next_status);
            ready.notify_one();
        });
        let block = block.copy();
        let _: () = msg_send![class!(SFSpeechRecognizer), requestAuthorization: &*block];

        let (lock, ready) = &*result;
        let status = ready
            .wait_timeout_while(
                lock.lock().expect("speech authorization state poisoned"),
                Duration::from_secs(30),
                |value| value.is_none(),
            )
            .map_err(|_| "Speech Recognition permission check failed.".to_string())?
            .0
            .take()
            .ok_or_else(|| "Speech Recognition permission request timed out.".to_string())?;
        if status == 3 {
            Ok(())
        } else {
            Err(
                "Allow Kordi to use Speech Recognition in System Settings and try again."
                    .to_string(),
            )
        }
    }
}

pub(in crate::voice_message) fn transcribe(path: &str, locale: &str) -> Result<String, String> {
    let path = std::fs::canonicalize(Path::new(path))
        .map_err(|error| format!("Unable to read the voice message: {error}"))?;
    if !path.is_file() {
        return Err("Voice message audio is unavailable.".to_string());
    }
    let locale = normalized_locale(locale);

    autoreleasepool(|_| unsafe {
        authorized()?;
        let locale_string = NSString::from_str(locale);
        let locale_object: *mut AnyObject = msg_send![class!(NSLocale), alloc];
        let locale_object: *mut AnyObject =
            msg_send![locale_object, initWithLocaleIdentifier: &*locale_string];
        let recognizer: *mut AnyObject = msg_send![class!(SFSpeechRecognizer), alloc];
        let recognizer: *mut AnyObject = msg_send![recognizer, initWithLocale: locale_object];
        if recognizer.is_null() {
            return Err("Speech Recognition does not support this language.".to_string());
        }
        let available: bool = msg_send![recognizer, isAvailable];
        let supports_on_device: bool = msg_send![recognizer, supportsOnDeviceRecognition];
        if !available {
            return Err("Speech Recognition is unavailable for this language.".to_string());
        }

        let path_string = NSString::from_str(&path.to_string_lossy());
        let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*path_string];
        let request: *mut AnyObject = msg_send![class!(SFSpeechURLRecognitionRequest), alloc];
        let request: *mut AnyObject = msg_send![request, initWithURL: url];
        if request.is_null() {
            return Err("Unable to prepare the voice message for transcription.".to_string());
        }
        let _: () = msg_send![request, setShouldReportPartialResults: false];
        let _: () = msg_send![request, setRequiresOnDeviceRecognition: supports_on_device];

        let result = Arc::new((Mutex::new(None::<Result<String, String>>), Condvar::new()));
        let callback_result = result.clone();
        let block = StackBlock::new(move |recognition: *mut AnyObject, error: *mut AnyObject| {
            let (lock, ready) = &*callback_result;
            if !error.is_null() {
                let description: *mut AnyObject = msg_send![error, localizedDescription];
                let description = if description.is_null() {
                    "Speech Recognition could not transcribe this recording.".to_string()
                } else {
                    (&*(description as *const NSString)).to_string()
                };
                *lock.lock().expect("speech recognition state poisoned") = Some(Err(description));
                ready.notify_one();
                return;
            }
            if recognition.is_null() {
                return;
            }
            let final_result: bool = msg_send![recognition, isFinal];
            if !final_result {
                return;
            }
            let transcription: *mut AnyObject = msg_send![recognition, bestTranscription];
            let text: *mut AnyObject = msg_send![transcription, formattedString];
            let text = if text.is_null() {
                String::new()
            } else {
                (&*(text as *const NSString)).to_string()
            };
            *lock.lock().expect("speech recognition state poisoned") =
                Some(if text.trim().is_empty() {
                    Err("No recognizable speech was found in this recording.".to_string())
                } else {
                    Ok(text.trim().to_string())
                });
            ready.notify_one();
        });
        let block = block.copy();
        let task: *mut AnyObject = msg_send![recognizer,
            recognitionTaskWithRequest: request,
            resultHandler: &*block
        ];
        if task.is_null() {
            return Err("Unable to start on-device transcription.".to_string());
        }

        let (lock, ready) = &*result;
        let mut result = ready
            .wait_timeout_while(
                lock.lock().expect("speech recognition state poisoned"),
                Duration::from_secs(75),
                |value| value.is_none(),
            )
            .map_err(|_| "On-device transcription failed.".to_string())?;
        if result.1.timed_out() {
            let _: () = msg_send![task, cancel];
            return Err("On-device transcription timed out. Try recording again.".to_string());
        }
        result
            .0
            .take()
            .unwrap_or_else(|| Err("No recognizable speech was found.".to_string()))
    })
}

pub(in crate::voice_message) fn trim(
    path: &str,
    start_ms: u64,
    end_ms: u64,
) -> Result<String, String> {
    let (start_seconds, duration_seconds) = voice_trim_range(start_ms, end_ms)?;
    let source = std::fs::canonicalize(Path::new(path))
        .map_err(|_| "Unable to read the voice message for trimming.".to_string())?;
    if !source.is_file() {
        return Err("Voice message audio is unavailable.".to_string());
    }
    let output = source
        .parent()
        .ok_or_else(|| "Voice message storage is unavailable.".to_string())?
        .join(format!("voice-trim-{}.m4a", uuid::Uuid::new_v4()));
    let status = Command::new("/usr/bin/avconvert")
        .args([
            "--source",
            source
                .to_str()
                .ok_or_else(|| "Voice message path is invalid.".to_string())?,
            "--output",
            output
                .to_str()
                .ok_or_else(|| "Voice message output path is invalid.".to_string())?,
            "--preset",
            "PresetAppleM4A",
            "--start",
            &start_seconds,
            "--duration",
            &duration_seconds,
            "--disableMetadataFilter",
        ])
        .status()
        .map_err(|_| "Unable to start native voice-message trimming.".to_string())?;
    if !status.success() || !output.is_file() {
        return Err("Unable to trim this voice message.".to_string());
    }
    Ok(output.to_string_lossy().into_owned())
}
