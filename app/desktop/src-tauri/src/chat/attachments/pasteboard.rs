//! Reads the file URLs on the system pasteboard, so a pasted path is attached
//! only when native code can see the same file on the pasteboard.

use std::path::PathBuf;

/// File paths currently on the general pasteboard. Empty on platforms
/// without a native pasteboard reader.
pub(crate) async fn general_pasteboard_file_paths<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Vec<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        // AppKit objects are read on the main thread.
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(macos::general_pasteboard_file_paths());
        })
        .map_err(|error| format!("Unable to read the pasted files: {error}"))?;
        receiver
            .await
            .map_err(|_| "Unable to read the pasted files.".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use std::path::PathBuf;

    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    const FILE_URL_TYPE: &str = "public.file-url";

    /// File paths of the file URLs on `pasteboard`. Finder writes file
    /// reference URLs (`file:///.file/id=...`), so each URL is resolved to its
    /// path form first.
    ///
    /// # Safety
    ///
    /// `pasteboard` must be a live `NSPasteboard`.
    pub(crate) unsafe fn file_paths_on(pasteboard: &AnyObject) -> Vec<PathBuf> {
        let file_url_type = NSString::from_str(FILE_URL_TYPE);
        let items: *const AnyObject = msg_send![pasteboard, pasteboardItems];
        let Some(items) = items.as_ref() else {
            return Vec::new();
        };
        let count: usize = msg_send![items, count];
        let mut paths = Vec::new();
        for index in 0..count {
            let item: *const AnyObject = msg_send![items, objectAtIndex: index];
            let Some(item) = item.as_ref() else { continue };
            let value: *const NSString = msg_send![item, stringForType: &*file_url_type];
            let Some(value) = value.as_ref() else {
                continue;
            };
            let url: *const AnyObject = msg_send![class!(NSURL), URLWithString: value];
            let Some(url) = url.as_ref() else { continue };
            let path_url: *const AnyObject = msg_send![url, filePathURL];
            let Some(path_url) = path_url.as_ref() else {
                continue;
            };
            let path: *const NSString = msg_send![path_url, path];
            if let Some(path) = path.as_ref() {
                paths.push(PathBuf::from(path.to_string()));
            }
        }
        paths
    }

    /// File paths on the general pasteboard. Call on the main thread.
    pub(crate) fn general_pasteboard_file_paths() -> Vec<PathBuf> {
        autoreleasepool(|_| {
            // SAFETY: `generalPasteboard` returns the shared, always-live
            // pasteboard; the selectors used are public AppKit APIs.
            unsafe {
                let pasteboard: *const AnyObject =
                    msg_send![class!(NSPasteboard), generalPasteboard];
                pasteboard
                    .as_ref()
                    .map(|pasteboard| file_paths_on(pasteboard))
                    .unwrap_or_default()
            }
        })
    }

    #[cfg(test)]
    mod tests {
        use std::sync::Mutex;

        use super::*;
        use objc2::rc::Retained;

        /// Serializes the tests' pasteboard work. Tests run on parallel
        /// worker threads, and AppKit pasteboards are not safe to create and
        /// use from several threads at once.
        static PASTEBOARD_LOCK: Mutex<()> = Mutex::new(());

        /// Writes `urls` to a private, uniquely named pasteboard (never the
        /// person's clipboard) and reads the file paths back.
        fn round_trip(urls: &[&AnyObject]) -> Vec<PathBuf> {
            let _pasteboard = PASTEBOARD_LOCK
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            autoreleasepool(|_| unsafe {
                let pasteboard: *mut AnyObject =
                    msg_send![class!(NSPasteboard), pasteboardWithUniqueName];
                let pasteboard = Retained::retain(pasteboard).expect("private pasteboard");
                let _: isize = msg_send![&*pasteboard, clearContents];
                let mut objects: Vec<*const AnyObject> =
                    urls.iter().map(|url| *url as *const AnyObject).collect();
                let array: *const AnyObject = msg_send![
                    class!(NSArray),
                    arrayWithObjects: objects.as_mut_ptr(),
                    count: objects.len()
                ];
                let written: bool = msg_send![&*pasteboard, writeObjects: array];
                assert!(written, "private pasteboard accepts file URLs");
                let paths = file_paths_on(&pasteboard);
                let _: () = msg_send![&*pasteboard, releaseGlobally];
                paths
            })
        }

        fn file_url(path: &std::path::Path) -> Retained<AnyObject> {
            let path = NSString::from_str(&path.display().to_string());
            unsafe {
                let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*path];
                Retained::retain(url).expect("file URL")
            }
        }

        #[test]
        fn reads_file_urls_including_finder_file_references() {
            let dir =
                std::env::temp_dir().join(format!("kordi-pasteboard-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let first = dir.join("first file.txt");
            let second = dir.join("second.pdf");
            std::fs::write(&first, b"first").unwrap();
            std::fs::write(&second, b"second").unwrap();

            let first_url = file_url(&first);
            let second_reference = unsafe {
                let url: *mut AnyObject = msg_send![&*file_url(&second), fileReferenceURL];
                Retained::retain(url).expect("file reference URL")
            };
            let paths = round_trip(&[&first_url, &second_reference]);

            let canonical = |path: &std::path::Path| std::fs::canonicalize(path).unwrap();
            let read: Vec<PathBuf> = paths.iter().map(|path| canonical(path)).collect();
            assert_eq!(read, vec![canonical(&first), canonical(&second)]);
            std::fs::remove_dir_all(dir).ok();
        }

        #[test]
        fn ignores_web_urls() {
            let web = NSString::from_str("https://example.test/report.pdf");
            let url = unsafe {
                let url: *mut AnyObject = msg_send![class!(NSURL), URLWithString: &*web];
                Retained::retain(url).expect("web URL")
            };
            assert!(round_trip(&[&url]).is_empty());
        }
    }
}
