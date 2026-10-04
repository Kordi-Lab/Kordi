use super::*;

async fn no_pasted_files() -> Result<Vec<PathBuf>, String> {
    Ok(Vec::new())
}

#[test]
fn safe_attachment_name_strips_path_segments() {
    assert_eq!(safe_attachment_name("/tmp/report.pdf"), "report.pdf");
    assert_eq!(safe_attachment_name("   "), "attachment.bin");
}

#[test]
fn stored_attachment_metadata_is_derived_from_extension() {
    let path = Path::new("screen.PNG");
    assert_eq!(stored_attachment_kind(path), "image");
    assert_eq!(
        stored_attachment_mime_type(path).as_deref(),
        Some("image/png")
    );
    assert_eq!(stored_attachment_format_label(path).as_deref(), Some("PNG"));
    assert_eq!(
        stored_attachment_mime_type(Path::new("recording.mp4")).as_deref(),
        Some("video/mp4")
    );
}

#[test]
fn stored_attachment_from_directory_preserves_folder_path() {
    let dir =
        std::env::temp_dir().join(format!("kordi-attachment-folder-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp attachment folder");

    let attachment = stored_chat_attachment_from_path(&dir).expect("directory attaches");

    assert_eq!(attachment.path, dir.display().to_string());
    assert_eq!(attachment.kind, "folder");
    assert_eq!(attachment.format_label.as_deref(), Some("Folder"));
    assert_eq!(attachment.size_bytes, None);

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn read_attachment_reads_file_bytes_and_rejects_directories() {
    let _app_data = crate::test_support::ScopedAppDataDir::new("attachment-read");
    let dir = attachment_storage_dir()
        .unwrap()
        .join(format!("read-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp attachment dir");
    let file = dir.join("report.txt");
    std::fs::write(&file, b"hello").expect("write temp attachment");

    let bytes = desktop_chat_read_attachment(file.display().to_string())
        .await
        .expect("read attachment bytes");
    assert_eq!(bytes, b"hello");

    let dir_error = desktop_chat_read_attachment(dir.display().to_string())
        .await
        .expect_err("directories are rejected");
    assert!(dir_error.contains("Attachment is not a file"));
}

#[tokio::test]
async fn selected_files_are_referenced_without_copying_and_reject_over_2_gib() {
    let _app_data = crate::test_support::ScopedAppDataDir::new("attachment-reference");
    let dir = std::env::temp_dir().join(format!(
        "kordi-attachment-reference-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp attachment dir");
    let file = dir.join("archive.zip");
    std::fs::write(&file, b"small").expect("write temp attachment");
    access::register_native_selection(&[&file]).expect("pick attachment");

    let stored = store_attachment_path(
        file.display().to_string(),
        Some("release.zip".to_string()),
        no_pasted_files,
    )
    .await
    .expect("reference selected attachment");
    assert_eq!(stored.path, file.display().to_string());
    assert_eq!(stored.name, "release.zip");

    let near_limit = dir.join("near-limit.bin");
    std::fs::File::create(&near_limit)
        .and_then(|file| file.set_len(MAX_CHAT_ATTACHMENT_SIZE_BYTES))
        .expect("create sparse near-limit attachment");
    access::register_native_selection(&[&near_limit]).expect("pick attachment");
    let stored = store_attachment_path(near_limit.display().to_string(), None, no_pasted_files)
        .await
        .expect("accept attachment at limit");
    assert_eq!(stored.path, near_limit.display().to_string());
    assert_eq!(stored.size_bytes, Some(MAX_CHAT_ATTACHMENT_SIZE_BYTES));

    let oversized = dir.join("oversized.bin");
    std::fs::File::create(&oversized)
        .and_then(|file| file.set_len(MAX_CHAT_ATTACHMENT_SIZE_BYTES + 1))
        .expect("create sparse oversized attachment");
    access::register_native_selection(&[&oversized]).expect("pick attachment");
    let error = store_attachment_path(oversized.display().to_string(), None, no_pasted_files)
        .await
        .expect_err("oversized attachment is rejected");
    assert_eq!(error, "Attachments must be 2 GiB or smaller.");

    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn attaching_by_path_needs_a_native_selection_paste_or_reference() {
    let _app_data = crate::test_support::ScopedAppDataDir::new("attachment-path-sources");
    let dir =
        std::env::temp_dir().join(format!("kordi-attachment-sources-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create outside dir");
    let named_only = dir.join("named-only.txt");
    let pasted = dir.join("pasted.txt");
    let referenced = dir.join("referenced.txt");
    for file in [&named_only, &pasted, &referenced] {
        std::fs::write(file, b"notes").expect("write outside file");
    }

    // A path the UI only names is neither readable nor attachable.
    assert_eq!(
        desktop_chat_read_attachment(named_only.display().to_string())
            .await
            .expect_err("unattached files are refused"),
        access::ATTACHMENT_ACCESS_DENIED
    );
    assert_eq!(
        store_attachment_path(named_only.display().to_string(), None, no_pasted_files)
            .await
            .expect_err("naming a path does not attach it"),
        access::ATTACHMENT_ACCESS_DENIED
    );
    let pasteboard_holds_other_file = || {
        let pasted = pasted.clone();
        async move { Ok(vec![pasted]) }
    };
    assert_eq!(
        store_attachment_path(
            named_only.display().to_string(),
            None,
            pasteboard_holds_other_file
        )
        .await
        .expect_err("only files on the pasteboard count as pasted"),
        access::ATTACHMENT_ACCESS_DENIED
    );

    // A paste attaches the file that native code found on the pasteboard.
    let pasteboard_holds_pasted = || {
        let pasted = pasted.clone();
        async move { Ok(vec![pasted]) }
    };
    store_attachment_path(pasted.display().to_string(), None, pasteboard_holds_pasted)
        .await
        .expect("pasted file attaches");
    assert_eq!(
        desktop_chat_read_attachment(pasted.display().to_string())
            .await
            .expect("pasted file is readable"),
        b"notes"
    );

    // An `@` reference registers the file before it is attached.
    desktop_chat_attach_reference_path(referenced.display().to_string())
        .await
        .expect("reference registers the file");
    store_attachment_path(referenced.display().to_string(), None, no_pasted_files)
        .await
        .expect("referenced file attaches");

    assert_eq!(
        desktop_chat_read_attachment(named_only.display().to_string())
            .await
            .expect_err("still refused"),
        access::ATTACHMENT_ACCESS_DENIED
    );
    std::fs::remove_dir_all(&dir).ok();
}
