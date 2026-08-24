use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSString, NSURL};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use super::super::NativeVoicePlaybackSample;

struct NativePlayback {
    player: usize,
    path: String,
    paused: bool,
}

static PLAYBACK: OnceLock<Mutex<Option<NativePlayback>>> = OnceLock::new();

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

unsafe fn player_sample(
    player: *mut AnyObject,
    expected_playing: bool,
) -> NativeVoicePlaybackSample {
    let current: f64 = msg_send![player, currentTime];
    let duration: f64 = msg_send![player, duration];
    let reported_playing: bool = msg_send![player, isPlaying];
    NativeVoicePlaybackSample {
        current_ms: (current.max(0.0) * 1_000.0).round() as u64,
        duration_ms: (duration.max(0.0) * 1_000.0).round() as u64,
        playing: reported_playing || (expected_playing && duration > 0.0 && current < duration),
    }
}

unsafe fn stop_player(active: NativePlayback) {
    let player = active.player as *mut AnyObject;
    let _: () = msg_send![player, stop];
    let _: () = msg_send![player, release];
}

pub(in crate::voice_message) fn play(path: &str) -> Result<NativeVoicePlaybackSample, String> {
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
            return Ok(player_sample(player, true));
        }
        if let Some(active) = current.take() {
            stop_player(active);
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
        Ok(player_sample(player, true))
    })
}

pub(in crate::voice_message) fn pause(path: &str) -> Result<NativeVoicePlaybackSample, String> {
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
        Ok(player_sample(player, false))
    }
}

pub(in crate::voice_message) fn seek(
    path: &str,
    position_ms: u64,
) -> Result<NativeVoicePlaybackSample, String> {
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
        Ok(player_sample(player, !active.paused))
    }
}

pub(in crate::voice_message) fn sample(path: &str) -> Result<NativeVoicePlaybackSample, String> {
    let path = playback_path(path)?;
    let current = playback()
        .lock()
        .map_err(|_| "Voice playback is unavailable.".to_string())?;
    let Some(active) = current.as_ref().filter(|active| active.path == path) else {
        return Ok(NativeVoicePlaybackSample {
            current_ms: 0,
            duration_ms: 0,
            playing: false,
        });
    };
    unsafe {
        Ok(player_sample(
            active.player as *mut AnyObject,
            !active.paused,
        ))
    }
}

pub(in crate::voice_message) fn stop(path: &str) -> Result<(), String> {
    let Ok(path) = playback_path(path) else {
        return Ok(());
    };
    let mut current = playback()
        .lock()
        .map_err(|_| "Voice playback is unavailable.".to_string())?;
    if current.as_ref().is_some_and(|active| active.path == path) {
        unsafe { stop_player(current.take().unwrap()) };
    }
    Ok(())
}
