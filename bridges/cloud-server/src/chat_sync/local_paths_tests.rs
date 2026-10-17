use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

use super::{file_name, is_local_path, strip_local_paths, stripped_agent_body};

#[test]
fn bold_links_to_local_files_keep_only_their_labels() {
    let reply = "Done. Files:\n- **[Launch plan](/Users/example/Documents/Launch plan.md)**\n\
                 - **[Launch plan (Word)](file:///Users/example/Documents/Launch%20plan.docx)**";
    let stripped = strip_local_paths(reply);
    assert_eq!(
        stripped,
        "Done. Files:\n- **Launch plan**\n- **Launch plan (Word)**"
    );
    assert!(!stripped.contains("/Users/"));
}

#[test]
fn bare_local_paths_become_file_names() {
    let cases = [
        (
            "Saved to /Users/example/Documents/plan.md.",
            "Saved to plan.md.",
        ),
        (
            "See `~/Notes/today.md` for details",
            "See `today.md` for details",
        ),
        (
            "Wrote /home/sam/work/report.html, then",
            "Wrote report.html, then",
        ),
        (
            "Folder: /Volumes/Backup/Projects/ and C:\\Users\\example\\notes.txt",
            "Folder: Projects and notes.txt",
        ),
        (
            "Temp file /private/var/folders/x1/T/out.md (removed)",
            "Temp file out.md (removed)",
        ),
        ("![chart](/Users/example/Desktop/chart.png)", "chart"),
        ("[](/Users/example/Desktop/chart.png)", "chart.png"),
    ];
    for (input, expected) in cases {
        assert_eq!(strip_local_paths(input), expected, "{input}");
    }
}

#[test]
fn urls_relative_paths_and_ordinary_text_are_unchanged() {
    for text in [
        "Read [the guide](https://example.com/Users/example/guide) and https://example.com/home/x",
        "Run `src/main.rs` and docs/plan.md",
        "1/2 of the team, a/b testing, ~approximately",
        "No paths here.",
        "[unterminated](/Users/example",
    ] {
        let expected = if text.starts_with("[unterminated") {
            "[unterminated](example"
        } else {
            text
        };
        assert_eq!(strip_local_paths(text), expected, "{text}");
    }
}

#[test]
fn file_names_and_local_targets() {
    assert_eq!(file_name("/Users/example/Documents/plan.md"), "plan.md");
    assert_eq!(file_name("/Users/example/Documents/"), "Documents");
    assert!(is_local_path("<file:///Users/example/a.md>"));
    assert!(is_local_path("~/a.md"));
    assert!(!is_local_path("https://kordi.ai/d/token"));
    assert!(!is_local_path("docs/a.md"));
}

fn group_body(sender_kind: &str, text: &str) -> String {
    let envelope = json!({
        "kind": "group-message",
        "groupId": "session:group:test",
        "message": { "id": "m1", "senderAccountId": "acct_owner", "senderKind": sender_kind, "text": text }
    });
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    )
}

fn decoded(body: &str, prefix: &str) -> Value {
    let encoded = body.strip_prefix(prefix).unwrap();
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
}

#[test]
fn agent_group_replies_lose_local_paths_and_people_keep_theirs() {
    let text = "Created **[plan.md](/Users/example/Documents/plan.md)**";
    let stripped = stripped_agent_body(&group_body("agent", text), false).unwrap();
    let envelope = decoded(&stripped, "kordi-cloud-group:");
    assert_eq!(envelope["message"]["text"], "Created **plan.md**");
    assert_eq!(envelope["message"]["id"], "m1");

    // A person's own message, and a reply without paths, are left alone.
    assert!(stripped_agent_body(&group_body("human", text), false).is_none());
    assert!(stripped_agent_body(&group_body("agent", "All done."), false).is_none());
}

#[test]
fn direct_agent_responses_are_stripped_only_between_two_people() {
    let envelope = json!({
        "kind": "agent-response",
        "requestId": "r1",
        "text": "Saved /Users/example/Desktop/notes.md",
        "deliveryState": "complete"
    });
    let body = format!(
        "kordi-cloud-agent-response:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
    );
    let stripped = stripped_agent_body(&body, true).unwrap();
    assert_eq!(
        decoded(&stripped, "kordi-cloud-agent-response:")["text"],
        "Saved notes.md"
    );
    // The owner's own chat with their agent keeps its text.
    assert!(stripped_agent_body(&body, false).is_none());
    assert!(stripped_agent_body("plain text /Users/example/a.md", true).is_none());
}
