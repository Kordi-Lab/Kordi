use super::*;

fn request() -> CreateReportRequest {
    CreateReportRequest {
        client_report_id: Uuid::new_v4(),
        reason: "spam".to_string(),
        details: None,
        reported_account_id: Some("acct_reported".to_string()),
        conversation_id: None,
        message_ids: Vec::new(),
        contact_request_id: None,
    }
}

fn invalid(result: Result<ValidReport, ReportError>) -> &'static str {
    match result {
        Err(ReportError::Invalid(message)) => message,
        other => panic!("expected an invalid report, got {other:?}"),
    }
}

#[test]
fn reasons_are_a_closed_list() {
    for reason in REASONS {
        let mut input = request();
        input.reason = format!(" {reason} ");
        assert_eq!(validate(input).unwrap().reason, reason);
    }
    let mut input = request();
    input.reason = "rude".to_string();
    assert_eq!(invalid(validate(input)), "Choose a reason for your report.");
}

#[test]
fn details_are_trimmed_cleaned_and_bounded() {
    let mut input = request();
    input.details = Some(format!("  a\0b{}  ", "c".repeat(997)));
    let valid = validate(input).unwrap();
    assert_eq!(valid.details.as_deref().map(str::len), Some(999));
    assert!(!valid.details.unwrap().contains('\0'));

    let mut input = request();
    input.details = Some("é".repeat(MAX_DETAILS_CHARS));
    assert!(
        validate(input).is_ok(),
        "the limit counts characters, not bytes"
    );
    let mut input = request();
    input.details = Some("x".repeat(MAX_DETAILS_CHARS + 1));
    assert_eq!(
        invalid(validate(input)),
        "Keep details under 1,000 characters."
    );

    let mut input = request();
    input.details = Some("   ".to_string());
    assert_eq!(validate(input).unwrap().details, None);
}

#[test]
fn message_reports_need_a_conversation_and_at_most_fifty_unique_messages() {
    let mut input = request();
    input.reported_account_id = None;
    assert_eq!(
        invalid(validate(input)),
        "Choose the account you're reporting."
    );

    let mut input = request();
    input.message_ids = vec![Uuid::new_v4()];
    assert_eq!(
        invalid(validate(input)),
        "Choose the conversation the messages are in."
    );

    let mut input = request();
    input.conversation_id = Some(Uuid::new_v4());
    input.message_ids = (0..=MAX_EVIDENCE_MESSAGES)
        .map(|_| Uuid::new_v4())
        .collect();
    assert_eq!(invalid(validate(input)), "Choose up to 50 messages.");

    let mut input = request();
    let id = Uuid::new_v4();
    input.conversation_id = Some(Uuid::new_v4());
    input.message_ids = vec![id, id];
    assert!(matches!(validate(input), Err(ReportError::Invalid(_))));

    let mut input = request();
    input.reported_account_id = None;
    input.conversation_id = Some(Uuid::new_v4());
    input.message_ids = vec![Uuid::new_v4()];
    let valid = validate(input).unwrap();
    assert_eq!(valid.target_kind(), "message");

    // Account reports ignore a conversation.
    let mut input = request();
    input.conversation_id = Some(Uuid::new_v4());
    let valid = validate(input).unwrap();
    assert_eq!(valid.conversation_id, None);
    assert_eq!(valid.target_kind(), "account");
}

#[test]
fn the_fingerprint_follows_every_field_but_not_whitespace() {
    let base = request();
    let first = validate(base.clone()).unwrap();
    let mut spaced = base.clone();
    spaced.reported_account_id = Some("  acct_reported ".to_string());
    assert_eq!(validate(spaced).unwrap().fingerprint, first.fingerprint);
    let mut other_reason = base.clone();
    other_reason.reason = "scam".to_string();
    assert_ne!(
        validate(other_reason).unwrap().fingerprint,
        first.fingerprint
    );
    let mut details = base;
    details.details = Some("more".to_string());
    assert_ne!(validate(details).unwrap().fingerprint, first.fingerprint);
    assert_eq!(first.fingerprint.len(), 64);
}

#[test]
fn references_are_short_uppercase_prefixes_of_the_report_id() {
    assert_eq!(
        reference("rpt_0123abcdef4567890123456789abcdef"),
        "R-0123ABCD"
    );
    let id = new_report_id();
    assert!(id.starts_with("rpt_") && id.len() == 36);
    let reference = reference(&id);
    assert_eq!(reference.len(), 10);
    assert_eq!(reference[2..], id[4..12].to_uppercase());
}

#[test]
fn evidence_larger_than_two_mebibytes_is_refused() {
    let fits = json!({ "content": "a".repeat(MAX_EVIDENCE_BYTES - 64) });
    assert!(within_size_limit(&fits));
    let too_large = json!({ "content": "a".repeat(MAX_EVIDENCE_BYTES) });
    assert!(!within_size_limit(&too_large));
}
