use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, AnyThread};
use objc2_avf_audio::{
    AVAudioFile, AVAudioFormat, AVEncoderAudioQualityKey, AVFormatIDKey, AVNumberOfChannelsKey,
    AVSampleRateKey,
};
use objc2_foundation::{NSDictionary, NSString, NSURL};

pub(super) unsafe fn create(
    path: &str,
    format: &AVAudioFormat,
) -> Result<Retained<AVAudioFile>, String> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let settings: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
    // AAC's valid bitrate range depends on sample rate and channel count. In
    // particular, forcing 64 kbit/s rejects 16 kHz mono headset input at open.
    // Let the native encoder choose a compatible bitrate for the source format.
    for (key, value) in [
        (AVFormatIDKey, 0x6161_6320u32 as f64),
        (AVSampleRateKey, format.sampleRate()),
        (AVNumberOfChannelsKey, format.channelCount() as f64),
        (AVEncoderAudioQualityKey, 96.0),
    ] {
        let key = key.ok_or_else(|| "Native audio settings are unavailable.".to_string())?;
        let number: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: value];
        let _: () = msg_send![settings, setObject: number, forKey: key];
    }
    let settings = &*(settings as *const NSDictionary<NSString, AnyObject>);
    AVAudioFile::initForWriting_settings_commonFormat_interleaved_error(
        AVAudioFile::alloc(),
        &url,
        settings,
        format.commonFormat(),
        format.isInterleaved(),
    )
    .map_err(|error| {
        let _ = std::fs::remove_file(path);
        format!(
            "The Mac recorder could not create audio for this microphone ({:.0} Hz, {} channels; audio error {}). Try another microphone.",
            format.sampleRate(), format.channelCount(), error.code(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::rc::autoreleasepool;
    use objc2_avf_audio::AVAudioPCMBuffer;
    use std::path::PathBuf;

    struct SyntheticAudio(PathBuf);
    impl Drop for SyntheticAudio {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn round_trip(sample_rate: f64, channels: u32) {
        let audio = SyntheticAudio(std::env::temp_dir().join(format!(
            "kordi-synthetic-voice-{}.m4a",
            uuid::Uuid::new_v4()
        )));
        autoreleasepool(|_| unsafe {
            let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
                AVAudioFormat::alloc(),
                sample_rate,
                channels,
            )
            .expect("create synthetic PCM format");
            let file =
                create(audio.0.to_str().unwrap(), &format).expect("create native AAC recording");
            let frames = (sample_rate * 2.0) as u32;
            let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &format,
                frames,
            )
            .expect("allocate synthetic PCM samples");
            buffer.setFrameLength(frames);
            let data = buffer.floatChannelData();
            assert!(!data.is_null());
            for channel in 0..channels as usize {
                let samples = (*data.add(channel)).as_ptr();
                for frame in 0..frames as usize {
                    *samples.add(frame) =
                        (frame as f64 * 440.0 * std::f64::consts::TAU / sample_rate).sin() as f32
                            * 0.1;
                }
            }
            file.writeFromBuffer_error(&buffer)
                .expect("encode synthetic microphone samples");
            file.close();
            let size = std::fs::metadata(&audio.0).unwrap().len();
            assert!(
                size >= 1_024,
                "AAC recording must contain audio beyond its header"
            );
            let url = NSURL::fileURLWithPath(&NSString::from_str(audio.0.to_str().unwrap()));
            let decoded = AVAudioFile::initForReading_error(AVAudioFile::alloc(), &url)
                .expect("reopen encoded recording for playback or transcription");
            assert_eq!(decoded.length(), i64::from(frames));
            let output = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
                AVAudioPCMBuffer::alloc(),
                &decoded.processingFormat(),
                frames,
            )
            .expect("allocate decoded samples");
            decoded
                .readIntoBuffer_error(&output)
                .expect("decode native AAC recording");
            assert_eq!(output.frameLength(), frames);
            let samples = (*output.floatChannelData()).as_ptr();
            assert!((0..frames as usize).any(|frame| (*samples.add(frame)).abs() > 0.01));
            decoded.close();
        });
    }

    #[test]
    fn headset_16khz_mono_recording_contains_decodable_audio() {
        round_trip(16_000.0, 1);
    }

    #[test]
    fn common_mono_and_stereo_inputs_contain_decodable_audio() {
        for rate in [8_000.0, 24_000.0, 44_100.0, 48_000.0] {
            for channels in [1, 2] {
                round_trip(rate, channels);
            }
        }
    }
}
