#[cfg(any(target_os = "macos", test))]
use std::io::Read;
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(any(target_os = "macos", test))]
const MAX_AVATAR_SOURCE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedAvatarImage {
    name: String,
    content_type: &'static str,
    bytes: Vec<u8>,
}

#[cfg(any(target_os = "macos", test))]
fn read_avatar_image(path: &Path) -> Result<PickedAvatarImage, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("Choose a PNG, JPEG, or WebP image.".into()),
    };
    let file = std::fs::File::open(path).map_err(|_| "Could not read that photo.")?;
    if !file
        .metadata()
        .map_err(|_| "Could not read that photo.")?
        .is_file()
    {
        return Err("Choose a photo file.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_AVATAR_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read that photo.")?;
    if bytes.len() as u64 > MAX_AVATAR_SOURCE_BYTES {
        return Err("Avatar source must be 2 MiB or smaller.".into());
    }
    Ok(PickedAvatarImage {
        name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("photo.png")
            .into(),
        content_type,
        bytes,
    })
}

#[cfg(target_os = "macos")]
fn choose_avatar_path() -> Result<Option<PathBuf>, String> {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSArray, NSString, NSURL};

    // SAFETY: called only from Tauri's with_webview main-thread closure.
    // Retained objects stay on that thread; only the selected path leaves it.
    unsafe {
        let pointer: *mut AnyObject = msg_send![class!(NSOpenPanel), openPanel];
        let panel = Retained::retain(pointer).ok_or("Could not open the photo picker.")?;
        let types = NSArray::from_retained_slice(&[
            NSString::from_str("png"),
            NSString::from_str("jpg"),
            NSString::from_str("jpeg"),
            NSString::from_str("webp"),
        ]);
        let _: () = msg_send![&*panel, setTitle: &*NSString::from_str("Upload photo")];
        let _: () = msg_send![&*panel, setPrompt: &*NSString::from_str("Choose photo")];
        let _: () = msg_send![&*panel, setCanChooseFiles: true];
        let _: () = msg_send![&*panel, setCanChooseDirectories: false];
        let _: () = msg_send![&*panel, setAllowsMultipleSelection: false];
        let _: () = msg_send![&*panel, setAllowedFileTypes: &*types];
        let response: isize = msg_send![&*panel, runModal];
        if response != 1 {
            return Ok(None);
        }
        let url: Option<Retained<NSURL>> = msg_send![&*panel, URL];
        let path = url
            .and_then(|url| url.path())
            .ok_or("Could not read the selected photo.")?;
        Ok(Some(PathBuf::from(path.to_string())))
    }
}

#[tauri::command]
pub(crate) async fn desktop_pick_avatar_image(
    window: tauri::WebviewWindow,
) -> Result<Option<PickedAvatarImage>, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |_| {
                let _ = sender.send(choose_avatar_path());
            })
            .map_err(|_| "Could not open the photo picker.")?;
        let Some(path) = receiver
            .await
            .map_err(|_| "The photo picker was interrupted.")??
        else {
            return Ok(None);
        };
        tokio::task::spawn_blocking(move || read_avatar_image(&path).map(Some))
            .await
            .map_err(|_| "Could not read the selected photo.".to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("Native photo picking is unavailable on this platform.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_photo_reads_preserve_bytes_and_reject_oversized_or_unsupported_sources() {
        let directory =
            std::env::temp_dir().join(format!("kordi-avatar-picker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let image = directory.join("photo.PNG");
        std::fs::write(&image, [137, 80, 78, 71]).unwrap();
        let selected = read_avatar_image(&image).unwrap();
        assert_eq!(selected.name, "photo.PNG");
        assert_eq!(selected.content_type, "image/png");
        assert_eq!(selected.bytes, [137, 80, 78, 71]);
        let large = directory.join("large.jpg");
        std::fs::write(&large, vec![0; MAX_AVATAR_SOURCE_BYTES as usize + 1]).unwrap();
        assert_eq!(
            read_avatar_image(&large).err().unwrap(),
            "Avatar source must be 2 MiB or smaller."
        );
        assert_eq!(
            read_avatar_image(&directory.join("file.txt"))
                .err()
                .unwrap(),
            "Choose a PNG, JPEG, or WebP image."
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
