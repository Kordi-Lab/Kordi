#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceRecordingSample {
    duration_ms: u64,
    level: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoiceRecordingStop {
    path: String,
    duration_ms: u64,
    size_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVoicePlaybackSample {
    current_ms: u64,
    duration_ms: u64,
    playing: bool,
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::{RcBlock, StackBlock};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send, AnyThread};
    use objc2_avf_audio::{AVAudioEngine, AVAudioFile, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSDictionary, NSString, NSURL};
    use objc2_speech as _;
    use std::path::Path;
    use std::process::Command;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {}

    struct NativeRecording {
        engine: usize,
        input: usize,
        file: usize,
        path: String,
        started_at: Instant,
        level: Arc<AtomicU32>,
        write_failed: Arc<AtomicBool>,
    }

    struct NativePlayback {
        player: usize,
        path: String,
        paused: bool,
    }

    static RECORDING: OnceLock<Mutex<Option<NativeRecording>>> = OnceLock::new();
    static PLAYBACK: OnceLock<Mutex<Option<NativePlayback>>> = OnceLock::new();

    fn recording() -> &'static Mutex<Option<NativeRecording>> {
        RECORDING.get_or_init(|| Mutex::new(None))
    }

    fn playback() -> &'static Mutex<Option<NativePlayback>> {
        PLAYBACK.get_or_init(|| Mutex::new(None))
    }

    fn playback_path(path: &str) -> Result<String, String> {
        let path = std::fs::canonicalize(Path::new(path))
            .map_err(|_| "Voice message audio is unavailable.".to_string())?;
        if !path.is_file() {
            return Err("Voice message audio is unavailable.".to_string());
        }
        Ok(path.to_string_lossy().into_owned())
    }

    unsafe fn playback_sample(
        player: *mut AnyObject,
        expected_playing: bool,
    ) -> super::NativeVoicePlaybackSample {
        let current: f64 = msg_send![player, currentTime];
        let duration: f64 = msg_send![player, duration];
        let reported_playing: bool = msg_send![player, isPlaying];
        super::NativeVoicePlaybackSample {
            current_ms: (current.max(0.0) * 1_000.0).round() as u64,
            duration_ms: (duration.max(0.0) * 1_000.0).round() as u64,
            playing: reported_playing || (expected_playing && duration > 0.0 && current < duration),
        }
    }

    unsafe fn stop_playback(active: NativePlayback) {
        let player = active.player as *mut AnyObject;
        let _: () = msg_send![player, stop];
        let _: () = msg_send![player, release];
    }

    unsafe fn stop_recording(recording: NativeRecording, remove_file: bool) -> i64 {
        let input = recording.input as *mut AnyObject;
        let engine = recording.engine as *mut AnyObject;
        let file = recording.file as *mut AnyObject;
        let _: () = msg_send![input, removeTapOnBus: 0usize];
        let _: () = msg_send![engine, stop];
        let frame_count: i64 = msg_send![file, framePosition];
        let _: () = msg_send![file, close];
        let _: () = msg_send![input, release];
        let _: () = msg_send![engine, release];
        let _: () = msg_send![file, release];
        if remove_file {
            let _ = std::fs::remove_file(recording.path);
        }
        frame_count
    }

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

    fn microphone_authorized() -> Result<(), String> {
        unsafe {
            let media_type = NSString::from_str("soun");
            let status: isize = msg_send![class!(AVCaptureDevice),
                authorizationStatusForMediaType: &*media_type
            ];
            match status {
                3 => return Ok(()),
                1 | 2 => {
                    return Err(
                        "Allow Kordi to use the microphone in System Settings and try again."
                            .to_string(),
                    )
                }
                _ => {}
            }

            let result = Arc::new((Mutex::new(None), Condvar::new()));
            let callback_result = result.clone();
            let block = StackBlock::new(move |granted: Bool| {
                let (lock, ready) = &*callback_result;
                *lock
                    .lock()
                    .expect("microphone authorization state poisoned") = Some(granted.as_bool());
                ready.notify_one();
            });
            let block = block.copy();
            let _: () = msg_send![class!(AVCaptureDevice),
                requestAccessForMediaType: &*media_type,
                completionHandler: &*block
            ];

            let (lock, ready) = &*result;
            let granted = ready
                .wait_timeout_while(
                    lock.lock()
                        .expect("microphone authorization state poisoned"),
                    Duration::from_secs(30),
                    |value| value.is_none(),
                )
                .map_err(|_| "Microphone permission check failed.".to_string())?
                .0
                .take()
                .ok_or_else(|| "Microphone permission request timed out.".to_string())?;
            if granted {
                Ok(())
            } else {
                Err(
                    "Allow Kordi to use the microphone in System Settings and try again."
                        .to_string(),
                )
            }
        }
    }

    pub(super) fn transcribe(path: &str, locale: &str) -> Result<String, String> {
        let path = std::fs::canonicalize(Path::new(path))
            .map_err(|error| format!("Unable to read the voice message: {error}"))?;
        if !path.is_file() {
            return Err("Voice message audio is unavailable.".to_string());
        }
        let locale = super::normalized_locale(locale);

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
            let block =
                StackBlock::new(move |recognition: *mut AnyObject, error: *mut AnyObject| {
                    let (lock, ready) = &*callback_result;
                    if !error.is_null() {
                        let description: *mut AnyObject = msg_send![error, localizedDescription];
                        let description = if description.is_null() {
                            "Speech Recognition could not transcribe this recording.".to_string()
                        } else {
                            (&*(description as *const NSString)).to_string()
                        };
                        *lock.lock().expect("speech recognition state poisoned") =
                            Some(Err(description));
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

    pub(super) fn trim(path: &str, start_ms: u64, end_ms: u64) -> Result<String, String> {
        let (start_seconds, duration_seconds) = super::voice_trim_range(start_ms, end_ms)?;
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

    pub(super) fn record_start() -> Result<String, String> {
        let mut current = recording()
            .lock()
            .map_err(|_| "Voice recorder state is unavailable.".to_string())?;
        if let Some(previous) = current.take() {
            unsafe { stop_recording(previous, true) };
        }
        let path = std::env::temp_dir()
            .join(format!("kordi-voice-{}.m4a", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        autoreleasepool(|_| unsafe {
            microphone_authorized()?;
            let path_string = NSString::from_str(&path);
            let url = NSURL::fileURLWithPath(&path_string);
            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            let format = input.outputFormatForBus(0);
            if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
                return Err("This Mac has no available microphone input.".to_string());
            }
            let settings: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
            let entries = [
                ("AVFormatIDKey", 0x6161_6320u32 as f64),
                ("AVSampleRateKey", format.sampleRate()),
                ("AVNumberOfChannelsKey", format.channelCount() as f64),
                ("AVEncoderBitRateKey", 64_000.0),
                ("AVEncoderAudioQualityKey", 96.0),
            ];
            for (key, value) in entries {
                let key = NSString::from_str(key);
                let number: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: value];
                let _: () = msg_send![settings, setObject: number, forKey: &*key];
            }
            let settings = &*(settings as *const NSDictionary<NSString, AnyObject>);
            let file = AVAudioFile::initForWriting_settings_commonFormat_interleaved_error(
                AVAudioFile::alloc(),
                &url,
                settings,
                format.commonFormat(),
                format.isInterleaved(),
            )
            .map_err(|_| "The native Mac recorder could not create an audio file.".to_string())?;
            let level = Arc::new(AtomicU32::new(0));
            let write_failed = Arc::new(AtomicBool::new(false));
            let callback_level = level.clone();
            let callback_failed = write_failed.clone();
            let callback_file = file.clone();
            let tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)> =
                RcBlock::new(
                    move |buffer: NonNull<AVAudioPCMBuffer>, _: NonNull<AVAudioTime>| {
                        let buffer = buffer.as_ref();
                        if callback_file.writeFromBuffer_error(buffer).is_err() {
                            callback_failed.store(true, Ordering::Relaxed);
                        }
                        let channels = buffer.floatChannelData();
                        if channels.is_null() {
                            return;
                        }
                        let samples = (*channels).as_ptr();
                        let frame_count = buffer.frameLength() as usize;
                        let stride = buffer.stride();
                        let mut peak = 0.0f32;
                        for frame in (0..frame_count).step_by(8) {
                            peak = peak.max((*samples.add(frame * stride)).abs());
                        }
                        callback_level.store(peak.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
                    },
                );
            input.installTapOnBus_bufferSize_format_block(
                0,
                2_048,
                Some(&format),
                RcBlock::as_ptr(&tap),
            );
            engine.prepare();
            if engine.startAndReturnError().is_err() {
                input.removeTapOnBus(0);
                let _ = std::fs::remove_file(&path);
                return Err("The native Mac microphone could not start.".to_string());
            }
            *current = Some(NativeRecording {
                engine: Retained::into_raw(engine) as usize,
                input: Retained::into_raw(input) as usize,
                file: Retained::into_raw(file) as usize,
                path: path.clone(),
                started_at: Instant::now(),
                level,
                write_failed,
            });
            Ok(path.clone())
        })
    }

    pub(super) fn record_sample() -> Result<super::NativeVoiceRecordingSample, String> {
        let current = recording()
            .lock()
            .map_err(|_| "Voice recorder state is unavailable.".to_string())?;
        let active = current
            .as_ref()
            .ok_or_else(|| "Voice recording is not active.".to_string())?;
        Ok(super::NativeVoiceRecordingSample {
            duration_ms: active.started_at.elapsed().as_millis() as u64,
            level: f32::from_bits(active.level.load(Ordering::Relaxed)).clamp(0.08, 1.0) as f64,
        })
    }

    pub(super) fn record_stop() -> Result<super::NativeVoiceRecordingStop, String> {
        let active = recording()
            .lock()
            .map_err(|_| "Voice recorder state is unavailable.".to_string())?
            .take()
            .ok_or_else(|| "Voice recording is not active.".to_string())?;
        let duration_ms = active.started_at.elapsed().as_millis() as u64;
        let write_failed = active.write_failed.load(Ordering::Relaxed);
        let path = active.path.clone();
        let frame_count = unsafe { stop_recording(active, false) };
        let size_bytes = std::fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or_default();
        if write_failed || !super::voice_audio_is_playable(frame_count, size_bytes) {
            let _ = std::fs::remove_file(path);
            return Err("The Mac microphone stopped before audio could be saved.".to_string());
        }
        Ok(super::NativeVoiceRecordingStop {
            path,
            duration_ms,
            size_bytes,
        })
    }

    pub(super) fn record_cancel() -> Result<(), String> {
        if let Some(active) = recording()
            .lock()
            .map_err(|_| "Voice recorder state is unavailable.".to_string())?
            .take()
        {
            unsafe { stop_recording(active, true) };
        }
        Ok(())
    }

    pub(super) fn play(path: &str) -> Result<super::NativeVoicePlaybackSample, String> {
        let path = playback_path(path)?;
        let mut current = playback()
            .lock()
            .map_err(|_| "Voice playback is unavailable.".to_string())?;
        autoreleasepool(|_| unsafe {
            if let Some(active) = current.as_mut().filter(|active| active.path == path) {
                let player = active.player as *mut AnyObject;
                let started: bool = msg_send![player, play];
                if !started {
                    return Err("Voice message could not start playing.".to_string());
                }
                active.paused = false;
                return Ok(playback_sample(player, true));
            }
            if let Some(active) = current.take() {
                stop_playback(active);
            }
            let path_string = NSString::from_str(&path);
            let url = NSURL::fileURLWithPath(&path_string);
            let player: *mut AnyObject = msg_send![class!(AVAudioPlayer), alloc];
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let player: *mut AnyObject =
                msg_send![player, initWithContentsOfURL: &*url, error: &mut error];
            if player.is_null() {
                return Err("Voice message audio format is unavailable.".to_string());
            }
            let prepared: bool = msg_send![player, prepareToPlay];
            let started: bool = msg_send![player, play];
            if !prepared || !started {
                let _: () = msg_send![player, release];
                return Err("Voice message could not start playing.".to_string());
            }
            *current = Some(NativePlayback {
                player: player as usize,
                path,
                paused: false,
            });
            Ok(playback_sample(player, true))
        })
    }

    pub(super) fn pause(path: &str) -> Result<super::NativeVoicePlaybackSample, String> {
        let path = playback_path(path)?;
        let mut current = playback()
            .lock()
            .map_err(|_| "Voice playback is unavailable.".to_string())?;
        let active = current
            .as_mut()
            .filter(|active| active.path == path)
            .ok_or_else(|| "Voice message is not playing.".to_string())?;
        unsafe {
            let player = active.player as *mut AnyObject;
            let _: () = msg_send![player, pause];
            active.paused = true;
            Ok(playback_sample(player, false))
        }
    }

    pub(super) fn seek(
        path: &str,
        position_ms: u64,
    ) -> Result<super::NativeVoicePlaybackSample, String> {
        let path = playback_path(path)?;
        let current = playback()
            .lock()
            .map_err(|_| "Voice playback is unavailable.".to_string())?;
        let active = current
            .as_ref()
            .filter(|active| active.path == path)
            .ok_or_else(|| "Voice message is not loaded.".to_string())?;
        unsafe {
            let player = active.player as *mut AnyObject;
            let duration: f64 = msg_send![player, duration];
            let position = (position_ms as f64 / 1_000.0).clamp(0.0, duration.max(0.0));
            let _: () = msg_send![player, setCurrentTime: position];
            Ok(playback_sample(player, !active.paused))
        }
    }

    pub(super) fn sample(path: &str) -> Result<super::NativeVoicePlaybackSample, String> {
        let path = playback_path(path)?;
        let current = playback()
            .lock()
            .map_err(|_| "Voice playback is unavailable.".to_string())?;
        let Some(active) = current.as_ref().filter(|active| active.path == path) else {
            return Ok(super::NativeVoicePlaybackSample {
                current_ms: 0,
                duration_ms: 0,
                playing: false,
            });
        };
        unsafe {
            Ok(playback_sample(
                active.player as *mut AnyObject,
                !active.paused,
            ))
        }
    }

    pub(super) fn stop(path: &str) -> Result<(), String> {
        let Ok(path) = playback_path(path) else {
            return Ok(());
        };
        let mut current = playback()
            .lock()
            .map_err(|_| "Voice playback is unavailable.".to_string())?;
        if current.as_ref().is_some_and(|active| active.path == path) {
            unsafe { stop_playback(current.take().unwrap()) };
        }
        Ok(())
    }
}

fn voice_audio_is_playable(frame_count: i64, size_bytes: u64) -> bool {
    frame_count > 0 && size_bytes >= 1_024
}

fn normalized_locale(locale: &str) -> &str {
    let locale = locale.trim();
    if locale.is_empty() || locale.len() > 64 {
        "en-US"
    } else {
        locale
    }
}

fn voice_trim_range(start_ms: u64, end_ms: u64) -> Result<(String, String), String> {
    if end_ms > 60_000 || start_ms >= end_ms || end_ms - start_ms < 250 {
        return Err("Choose at least 0.25 seconds within the voice message.".to_string());
    }
    Ok((
        format!("{:.3}", start_ms as f64 / 1_000.0),
        format!("{:.3}", (end_ms - start_ms) as f64 / 1_000.0),
    ))
}

#[cfg(target_os = "macos")]
async fn on_main_thread<T, F>(app: tauri::AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation());
    })
    .map_err(|error| format!("Voice playback could not reach the main thread: {error}"))?;
    receiver
        .await
        .map_err(|_| "Voice playback stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn desktop_voice_transcribe(path: String, locale: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || macos::transcribe(&path, &locale))
            .await
            .map_err(|error| format!("On-device transcription stopped unexpectedly: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, locale);
        Err("On-device transcription is currently available only on macOS.".to_string())
    }
}

#[tauri::command]
pub async fn desktop_voice_trim(
    path: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || macos::trim(&path, start_ms, end_ms))
            .await
            .map_err(|error| format!("Voice-message trimming stopped unexpectedly: {error}"))?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, start_ms, end_ms);
        Err("Voice-message trimming is currently available only on macOS.".to_string())
    }
}

#[tauri::command]
pub fn desktop_voice_record_start() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        macos::record_start()
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native voice recording is currently available only on macOS.".to_string())
}

#[tauri::command]
pub fn desktop_voice_record_sample() -> Result<NativeVoiceRecordingSample, String> {
    #[cfg(target_os = "macos")]
    {
        macos::record_sample()
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native voice recording is currently available only on macOS.".to_string())
}

#[tauri::command]
pub fn desktop_voice_record_stop() -> Result<NativeVoiceRecordingStop, String> {
    #[cfg(target_os = "macos")]
    {
        macos::record_stop()
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native voice recording is currently available only on macOS.".to_string())
}

#[tauri::command]
pub fn desktop_voice_record_cancel() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::record_cancel()
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native voice recording is currently available only on macOS.".to_string())
}

#[tauri::command]
pub async fn desktop_voice_play(
    app: tauri::AppHandle,
    path: String,
) -> Result<NativeVoicePlaybackSample, String> {
    #[cfg(target_os = "macos")]
    {
        on_main_thread(app, move || macos::play(&path)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        Err("Native voice playback is currently available only on macOS.".to_string())
    }
}

#[tauri::command]
pub async fn desktop_voice_pause(
    app: tauri::AppHandle,
    path: String,
) -> Result<NativeVoicePlaybackSample, String> {
    #[cfg(target_os = "macos")]
    {
        on_main_thread(app, move || macos::pause(&path)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        Err("Native voice playback is currently available only on macOS.".to_string())
    }
}

#[tauri::command]
pub async fn desktop_voice_seek(
    app: tauri::AppHandle,
    path: String,
    position_ms: u64,
) -> Result<NativeVoicePlaybackSample, String> {
    #[cfg(target_os = "macos")]
    {
        on_main_thread(app, move || macos::seek(&path, position_ms)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path, position_ms);
        Err("Native voice playback is currently available only on macOS.".to_string())
    }
}

#[tauri::command]
pub async fn desktop_voice_playback_sample(
    app: tauri::AppHandle,
    path: String,
) -> Result<NativeVoicePlaybackSample, String> {
    #[cfg(target_os = "macos")]
    {
        on_main_thread(app, move || macos::sample(&path)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        Err("Native voice playback is currently available only on macOS.".to_string())
    }
}

#[tauri::command]
pub async fn desktop_voice_stop(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        on_main_thread(app, move || macos::stop(&path)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, path);
        Err("Native voice playback is currently available only on macOS.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{normalized_locale, voice_audio_is_playable, voice_trim_range};

    #[test]
    fn voice_locale_is_trimmed_and_bounded() {
        assert_eq!(normalized_locale(" ar-SA "), "ar-SA");
        assert_eq!(normalized_locale(""), "en-US");
        assert_eq!(normalized_locale(&"x".repeat(65)), "en-US");
    }

    #[test]
    fn voice_trim_range_is_bounded_and_keeps_duration() {
        assert_eq!(
            voice_trim_range(1_250, 4_750).unwrap(),
            ("1.250".to_string(), "3.500".to_string())
        );
        assert!(voice_trim_range(1_000, 1_100).is_err());
        assert!(voice_trim_range(0, 60_001).is_err());
    }

    #[test]
    fn voice_audio_requires_frames_beyond_the_container_header() {
        assert!(voice_audio_is_playable(48_000, 8_000));
        assert!(!voice_audio_is_playable(0, 8_000));
        assert!(!voice_audio_is_playable(48_000, 557));
    }
}
