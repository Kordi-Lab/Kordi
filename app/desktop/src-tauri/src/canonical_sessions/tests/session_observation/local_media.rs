use super::*;
#[path = "../../../../../../../agent/crates/provider/tests/support/images.rs"]
mod images;

#[test]
fn local_images_are_retrievable_after_they_leave_prompt_context_and_reject_stale_references() {
    let conn = test_conn();
    let session = seed_session_with_messages(&conn);
    let root = std::env::var_os("APP_DATA_DIR")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("tmp/attachments"))
        .unwrap_or_else(|| std::env::temp_dir().join("kordi-desktop-attachments"));
    std::fs::create_dir_all(&root).unwrap();
    let file = TestImage(root.join(format!("local-history-{}.png", uuid::Uuid::new_v4())));
    std::fs::write(file.path(), images::RED_BLUE).unwrap();
    let metadata = serde_json::json!({"attachments":[{"localPath":file.path(),"name":"synthetic.png","kind":"image","mimeType":"image/png","sizeBytes":images::RED_BLUE.len()}]}).to_string();
    conn.execute(
        "UPDATE session_messages SET content_json=?1 WHERE id='msg:2'",
        [&metadata],
    )
    .unwrap();
    let request = ReadSessionRequest {
        session_id: session.clone(),
        mode: Some("index".into()),
        before_sequence: None,
        attachment_id: None,
        expected_version: None,
        offset: None,
        around_message_id: None,
        limit: Some(3),
        message_ids: None,
    };
    let read = |request| {
        super::super::super::session_observation::read_session_for_observation_in_db(&conn, request)
    };
    for kind in [
        "self-agent",
        "direct-person",
        "direct-agent",
        "relationship",
        "group",
        "project",
    ] {
        conn.execute(
            "UPDATE sessions SET kind=?1 WHERE id=?2",
            rusqlite::params![kind, session],
        )
        .unwrap();
        let view = read(request.clone()).unwrap();
        assert_eq!(view.session.kind, kind);
        assert_eq!(
            view.messages
                .iter()
                .map(|message| message.attachments.len())
                .sum::<usize>(),
            1
        );
    }
    conn.execute(
        "UPDATE sessions SET status='archived' WHERE id=?1",
        [&session],
    )
    .unwrap();
    let index = read(request.clone()).unwrap();
    let reference = index
        .messages
        .iter()
        .find(|m| m.message_id == "msg:2")
        .unwrap()
        .attachments[0]
        .clone();
    let attachment = ReadSessionRequest {
        mode: Some("attachment".into()),
        message_ids: Some(vec!["msg:2".into()]),
        attachment_id: Some(reference.attachment_id),
        expected_version: Some(reference.message_version),
        ..request.clone()
    };
    let result = read(attachment.clone()).unwrap();
    assert!(
        matches!(&result.media[0],kordi_core::types::ContentBlock::Image{mime_type,..} if mime_type=="image/png")
    );
    conn.execute(
        "UPDATE session_messages SET content_json='{}' WHERE id='msg:2'",
        [],
    )
    .unwrap();
    assert!(read(attachment).is_err());
    let page = read(ReadSessionRequest {
        before_sequence: Some(3),
        limit: Some(1),
        ..request
    })
    .unwrap();
    assert_eq!(page.messages[0].message_id, "msg:2");
    assert_eq!(page.next_before_sequence, Some(2));
    assert!(!images::GREEN_WHITE.is_empty());
}

struct TestImage(std::path::PathBuf);
impl TestImage {
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TestImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
