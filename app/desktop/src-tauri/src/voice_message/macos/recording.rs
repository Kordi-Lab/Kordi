use block2::{RcBlock, StackBlock};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send, AnyThread};
use objc2_avf_audio::{AVAudioEngine, AVAudioFile, AVAudioPCMBuffer, AVAudioTime};
use objc2_foundation::{NSDictionary, NSString, NSURL};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::super::{voice_audio_is_playable, NativeVoiceRecordingSample, NativeVoiceRecordingStop};

struct NativeRecording {
    engine: usize,
    input: usize,
    file: usize,
    path: String,
    started_at: Instant,
    level: Arc<AtomicU32>,
    write_failed: Arc<AtomicBool>,
}

static RECORDING: OnceLock<Mutex<Option<NativeRecording>>> = OnceLock::new();

fn recording() -> &'static Mutex<Option<NativeRecording>> {
    RECORDING.get_or_init(|| Mutex::new(None))
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
        })
        .copy();
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
        granted.then_some(()).ok_or_else(|| {
            "Allow Kordi to use the microphone in System Settings and try again.".to_string()
        })
    }
}

pub(in crate::voice_message) fn record_start() -> Result<String, String> {
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
        for (key, value) in [
            ("AVFormatIDKey", 0x6161_6320u32 as f64),
            ("AVSampleRateKey", format.sampleRate()),
            ("AVNumberOfChannelsKey", format.channelCount() as f64),
            ("AVEncoderBitRateKey", 64_000.0),
            ("AVEncoderAudioQualityKey", 96.0),
        ] {
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
        let tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)> = RcBlock::new(
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

pub(in crate::voice_message) fn record_sample() -> Result<NativeVoiceRecordingSample, String> {
    let current = recording()
        .lock()
        .map_err(|_| "Voice recorder state is unavailable.".to_string())?;
    let active = current
        .as_ref()
        .ok_or_else(|| "Voice recording is not active.".to_string())?;
    Ok(NativeVoiceRecordingSample {
        duration_ms: active.started_at.elapsed().as_millis() as u64,
        level: f32::from_bits(active.level.load(Ordering::Relaxed)).clamp(0.08, 1.0) as f64,
    })
}

pub(in crate::voice_message) fn record_stop() -> Result<NativeVoiceRecordingStop, String> {
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
    if write_failed || !voice_audio_is_playable(frame_count, size_bytes) {
        let _ = std::fs::remove_file(path);
        return Err("The Mac microphone stopped before audio could be saved.".to_string());
    }
    Ok(NativeVoiceRecordingStop {
        path,
        duration_ms,
        size_bytes,
    })
}

pub(in crate::voice_message) fn record_cancel() -> Result<(), String> {
    if let Some(active) = recording()
        .lock()
        .map_err(|_| "Voice recorder state is unavailable.".to_string())?
        .take()
    {
        unsafe { stop_recording(active, true) };
    }
    Ok(())
}
