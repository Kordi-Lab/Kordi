mod playback;
mod recording;
mod speech;

pub(super) use playback::{pause, play, sample, seek, stop};
pub(super) use recording::{record_cancel, record_sample, record_start, record_stop};
pub(super) use speech::{transcribe, trim};

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}
