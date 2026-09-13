use super::*;
use crate::store;
use chrono::Utc;
use kordi_core::types::*;

fn base(id: &str, parent: Option<&str>) -> EntryBase {
    EntryBase {
        id: EntryId(id.into()),
        parent_id: parent.map(|id| EntryId(id.into())),
        timestamp: Utc::now(),
    }
}

fn user(id: &str, parent: Option<&str>, content: Vec<ContentBlock>) -> SessionEntry {
    SessionEntry::Message {
        base: base(id, parent),
        message: AgentMessage::User(UserMessage {
            content,
            timestamp: 1000,
        }),
    }
}

fn image(data: &str) -> ContentBlock {
    ContentBlock::Image {
        data: data.into(),
        mime_type: "image/png".into(),
    }
}

fn text(value: &str) -> ContentBlock {
    ContentBlock::Text { text: value.into() }
}

fn images(context: &SessionContext) -> Vec<String> {
    context
        .messages
        .iter()
        .flat_map(|message| match message {
            AgentMessage::User(user) => user
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Image { data, .. } => Some(data.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        })
        .collect()
}

#[test]
fn text_followup_preserves_the_original_image_and_prompt_prefix_after_reloading() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    let original = user("upload", None, vec![image("original-upload")]);
    store::append_entry(&conn, &sid, &original).unwrap();
    let before = build_context(&conn, &sid).unwrap();
    let followup = user(
        "question",
        Some("upload"),
        vec![text("What is in that picture?")],
    );
    store::append_entry(&conn, &sid, &followup).unwrap();
    let after = build_context(&conn, &sid).unwrap();
    assert_eq!(images(&after), vec!["original-upload"]);
    assert_eq!(
        serde_json::to_value(&before.messages[0]).unwrap(),
        serde_json::to_value(&after.messages[0]).unwrap()
    );
    let path = crate::tree::active_path(&conn, &sid).unwrap();
    assert_eq!(
        images(&build_context_from_path(&path).unwrap()),
        vec!["original-upload"]
    );
}

#[test]
fn compaction_keeps_selected_images_without_restoring_discarded_images() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    for entry in [
        user("old", None, vec![image("discarded-image")]),
        user("kept", Some("old"), vec![image("retained-image")]),
        SessionEntry::Compaction {
            base: base("compact", Some("kept")),
            summary: "Earlier conversation summarized".into(),
            first_kept_entry_id: EntryId("kept".into()),
            tokens_before: 5000,
            details: None,
            from_plugin: false,
        },
        user(
            "question",
            Some("compact"),
            vec![text("Describe the retained picture")],
        ),
    ] {
        store::append_entry(&conn, &sid, &entry).unwrap();
    }
    assert_eq!(
        images(&build_context(&conn, &sid).unwrap()),
        vec!["retained-image"]
    );
}

#[test]
fn shared_context_boundary_does_not_reintroduce_an_earlier_request_image() {
    let conn = store::open_memory().unwrap();
    let sid = store::create_session(&conn, "/tmp").unwrap();
    for entry in [
        user("old", None, vec![image("unrelated-request-image")]),
        SessionEntry::Custom {
            base: base("boundary", Some("old")),
            custom_type: SHARED_CONTEXT_BOUNDARY.into(),
            data: None,
        },
        user(
            "question",
            Some("boundary"),
            vec![text("Current shared request")],
        ),
    ] {
        store::append_entry(&conn, &sid, &entry).unwrap();
    }
    assert!(images(&build_context(&conn, &sid).unwrap()).is_empty());
}
