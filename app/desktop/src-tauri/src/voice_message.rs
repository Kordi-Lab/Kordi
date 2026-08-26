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

const MINIMUM_VOICE_MESSAGE_DURATION_MS: u64 = 1_000;
const VOICE_RECORDING_TOO_SHORT_ERROR: &str = "Voice recording must be at least one second.";

#[cfg(target_os = "macos")]
mod macos;

fn voice_audio_is_playable(frame_count: i64, size_bytes: u64) -> bool {
    frame_count > 0 && size_bytes >= 1_024
}

fn voice_recording_duration_is_sendable(duration_ms: u64) -> bool {
    duration_ms >= MINIMUM_VOICE_MESSAGE_DURATION_MS
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
    use super::{
        normalized_locale, voice_audio_is_playable, voice_recording_duration_is_sendable,
        voice_trim_range,
    };

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

    #[test]
    fn voice_recording_requires_one_second() {
        assert!(!voice_recording_duration_is_sendable(999));
        assert!(voice_recording_duration_is_sendable(1_000));
    }
}
