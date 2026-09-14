use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

static WRITE_LOCK: Mutex<()> = Mutex::new(());
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn append_frames(path: &Path, frames: &[Vec<f64>]) -> Result<bool, String> {
    if !path.is_absolute()
        || frames.len() > 120
        || frames
            .iter()
            .any(|frame| frame.len() > 2048 || frame.iter().any(|value| !value.is_finite()))
    {
        return Err("Invalid transcript geometry trace".into());
    }
    if frames.is_empty() {
        return Ok(true);
    }
    let _guard = WRITE_LOCK.lock().map_err(|_| "Trace lock unavailable")?;
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= MAX_FILE_BYTES)
    {
        return Ok(false);
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Unable to open local geometry trace")?;
    for frame in frames {
        serde_json::to_writer(&mut file, frame).map_err(|_| "Unable to encode geometry trace")?;
        file.write_all(b"\n")
            .map_err(|_| "Unable to write geometry trace")?;
    }
    Ok(true)
}

/// Locally opted-in numeric geometry only. The webview cannot choose a path.
#[tauri::command]
pub(crate) fn desktop_transcript_trace(frames: Vec<Vec<f64>>) -> Result<bool, String> {
    let Some(directory) = std::env::var_os("KORDI_TRANSCRIPT_TRACE_DIR") else {
        return Ok(false);
    };
    append_frames(
        &Path::new(&directory).join("transcript-trajectory.jsonl"),
        &frames,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_trace_is_bounded_and_rejects_non_finite_values() {
        let directory =
            std::env::temp_dir().join(format!("kordi-geometry-trace-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("trace.jsonl");
        assert!(append_frames(&file, &[vec![1.0, 2.5]]).unwrap());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[1.0,2.5]\n");
        assert!(append_frames(&file, &[vec![f64::NAN]]).is_err());
        assert!(append_frames(&file, &vec![vec![]; 121]).is_err());
        assert!(append_frames(&file, &[vec![0.0; 2049]]).is_err());
        OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
        assert!(!append_frames(&file, &[vec![2.0]]).unwrap());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
