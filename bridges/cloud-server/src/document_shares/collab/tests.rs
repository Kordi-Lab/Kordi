//! Pure tests for collaboration tickets, the init grant, and frame decoding.
//! Socket and storage tests live in `document_shares/tests/collab_db.rs`.

use chrono::{Duration, Utc};

use super::rooms::decode_messages;
use super::tickets::{
    bind_origin, grants_init, random_ticket, ticket_hash, InitState, TicketError, TICKET_PREFIX,
};

#[test]
fn tickets_are_opaque_random_and_hash_stably() {
    let first = random_ticket();
    let second = random_ticket();
    assert!(first.starts_with(TICKET_PREFIX));
    assert_eq!(first.len(), TICKET_PREFIX.len() + 43);
    assert_ne!(first, second);
    assert_eq!(ticket_hash(&first).unwrap(), ticket_hash(&first).unwrap());
    assert_ne!(ticket_hash(&first).unwrap(), ticket_hash(&second).unwrap());
    assert!(!ticket_hash(&first)
        .unwrap()
        .contains(&first[TICKET_PREFIX.len()..]));
    for invalid in [
        "",
        "kordi_dc_short",
        "kordi_rt_AAAA",
        &first.replace(TICKET_PREFIX, "kordi_rt_"),
    ] {
        assert!(
            matches!(ticket_hash(invalid), Err(TicketError::InvalidTicket)),
            "{invalid}"
        );
    }
}

#[test]
fn ticket_origins_are_allowlisted_and_bound() {
    let allowed = vec![
        "tauri://localhost".to_string(),
        "http://127.0.0.1".to_string(),
    ];
    assert_eq!(
        bind_origin(None, &allowed).unwrap(),
        None,
        "native clients send no origin"
    );
    assert_eq!(bind_origin(Some("  "), &allowed).unwrap(), None);
    assert_eq!(
        bind_origin(Some("tauri://localhost"), &allowed)
            .unwrap()
            .as_deref(),
        Some("tauri://localhost")
    );
    assert_eq!(
        bind_origin(Some("http://127.0.0.1:1420"), &allowed)
            .unwrap()
            .as_deref(),
        Some("http://127.0.0.1:1420"),
        "a bare loopback entry allows any port"
    );
    for refused in ["null", "https://example.com", "http://127.0.0.2:1420"] {
        assert!(
            matches!(
                bind_origin(Some(refused), &allowed),
                Err(TicketError::OriginNotAllowed)
            ),
            "{refused}"
        );
    }
}

fn state(initialized: bool, holder: Option<&str>, expires_in: Option<i64>) -> InitState {
    let now = Utc::now();
    InitState {
        initialized,
        granted_to: holder.map(str::to_string),
        grant_expires_at: expires_in.map(|seconds| now + Duration::seconds(seconds)),
    }
}

#[test]
fn exactly_one_editor_is_granted_the_seed() {
    let now = Utc::now();
    assert!(
        grants_init(&state(false, None, None), "acct_a", now),
        "first caller"
    );
    assert!(
        grants_init(&state(false, Some("acct_a"), Some(20)), "acct_a", now),
        "holder keeps it"
    );
    assert!(
        !grants_init(&state(false, Some("acct_a"), Some(20)), "acct_b", now),
        "others wait"
    );
    assert!(
        grants_init(&state(false, Some("acct_a"), Some(-1)), "acct_b", now),
        "an expired grant passes on"
    );
    assert!(
        !grants_init(&state(true, None, None), "acct_a", now),
        "initialized rooms seed nobody"
    );
    assert!(!grants_init(
        &state(true, Some("acct_a"), Some(20)),
        "acct_a",
        now
    ));
}

#[test]
fn frames_must_hold_known_messages() {
    // Sync step 1 with an empty state vector: [0 sync, 0 step1, buf len 1, 0 entries].
    assert_eq!(decode_messages(&[0, 0, 1, 0]).unwrap().len(), 1);
    assert!(decode_messages(&[]).is_err(), "empty frame");
    assert!(decode_messages(&[0, 9]).is_err(), "unknown sync step");
    assert!(decode_messages(&[0, 0, 5, 1]).is_err(), "truncated");
}
