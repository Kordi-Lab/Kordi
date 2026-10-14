use super::*;

#[test]
fn low_information_seeds_wait_for_a_topic() {
    for value in [
        "hi",
        "hiiii",
        "hello!",
        "hi, how are you?",
        "Hi! How can I help?",
        "test",
        "test reply 11",
        "111",
        "👍🏽",
        "@MyKordi",
        "\u{4F60}\u{597D}",
    ] {
        assert_eq!(derive_session_title(value), None, "{value}");
    }
}

#[test]
fn meaningful_titles_remove_transport_noise_and_preserve_language() {
    assert_eq!(
        derive_session_title("@MyKordi help diagnose high Node CPU usage").as_deref(),
        Some("Diagnose high Node CPU")
    );
    assert_eq!(
        derive_session_title("which model are you").as_deref(),
        Some("Model and identity")
    );
    assert_eq!(
        derive_session_title("\u{4F60}\u{662F}\u{8C01}\u{4F60}\u{5728}\u{4F7F}\u{7528}\u{4EC0}\u{4E48}\u{6A21}\u{578B}").as_deref(),
        Some("\u{6A21}\u{578B}\u{4E0E}\u{8EAB}\u{4EFD}")
    );
}

#[test]
fn reply_code_url_and_command_context_do_not_become_titles() {
    assert_eq!(
        derive_session_title(
            "> old answer\n/retry @MyKordi plan release validation https://example.com"
        )
        .as_deref(),
        Some("Plan release validation")
    );
    assert_eq!(derive_session_title("```rust\nfn main() {}\n```"), None);
    assert_eq!(
        derive_session_title("Attached private-report.pdf please diagnose memory usage").as_deref(),
        Some("Diagnose memory usage")
    );
    assert_eq!(
        derive_session_title("[attachment: private-report.pdf] diagnose memory usage").as_deref(),
        Some("Diagnose memory usage")
    );
}

#[test]
fn titles_are_capped_by_graphemes_without_splitting_emoji() {
    let title = derive_session_title(
        "organize this deliberately very long conversation topic with enough extra words to overflow",
    )
    .unwrap();
    assert!(UnicodeSegmentation::graphemes(title.as_str(), true).count() <= 48);
}

#[test]
fn attachment_titles_never_depend_on_local_filenames() {
    assert_eq!(derive_session_title("Attached private-report.pdf"), None);
    assert_eq!(derive_session_title("Attachment: private-report.pdf"), None);
    assert_eq!(
        attachment_session_title(1, true).as_deref(),
        Some("Image attachment")
    );
    assert_eq!(
        attachment_session_title(1, false).as_deref(),
        Some("File attachment")
    );
    assert_eq!(
        attachment_session_title(3, true).as_deref(),
        Some("3 attachments")
    );
}

#[test]
fn title_source_precedence_is_explicit() {
    assert!(SessionTitleSource::Placeholder.can_be_replaced_by(SessionTitleSource::Auto));
    assert!(SessionTitleSource::Auto.can_be_replaced_by(SessionTitleSource::Manual));
    assert!(!SessionTitleSource::Manual.can_be_replaced_by(SessionTitleSource::Auto));
    assert!(!SessionTitleSource::Imported.can_be_replaced_by(SessionTitleSource::Auto));
}

#[test]
fn legacy_backfill_only_targets_known_generated_shapes() {
    assert!(is_known_legacy_auto_title("which model are you"));
    assert!(is_known_legacy_auto_title("Attached private-report.pdf"));
    assert!(is_known_legacy_auto_title("hello"));
    assert!(!is_known_legacy_auto_title("Release validation plan"));
    assert!(!is_known_legacy_auto_title("Model and identity"));
    assert!(is_known_legacy_auto_title("Chat with Kordi · Oct 13"));
    assert!(is_known_legacy_auto_title("Chat with Kordi · recently"));
    assert!(!is_known_legacy_auto_title(
        "Chat with Kordi about release dates"
    ));
    assert!(is_placeholder_or_weak_legacy_title(
        "Chat with Kordi · Jul 4",
        "session"
    ));
}

#[test]
fn voice_messages_name_sessions_only_from_their_transcript() {
    assert_eq!(
        derive_session_title(
            "[Voice transcript; audio was not provided. Tone, speaker identity, and background sounds are unknown.]\nplan the launch checklist"
        )
        .as_deref(),
        Some("Plan the launch checklist")
    );
    assert_eq!(
        derive_session_title(
            "[Voice message: transcription pending. No spoken content or audio was provided to the agent.]"
        ),
        None
    );
    assert_eq!(derive_session_title("Voice message"), None);
}

#[test]
fn raw_identifiers_are_recognized_without_matching_normal_titles() {
    let id = "e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83";
    assert!(is_raw_session_identifier(id, id));
    assert!(is_raw_session_identifier("session:self-agent:test", id));
    assert!(is_raw_session_identifier("Session e2b79cd7", id));
    assert!(!is_raw_session_identifier("Release validation plan", id));
}
