use super::*;
use serde_json::json;

#[test]
fn visibility_is_account_scoped_and_commits_with_the_cursor() {
    let mut conn = super::super::test_support::test_connection();
    let snapshot = json!({"hiddenSessionIds":["archived"],"deletedSessionIds":["deleted"],"pinnedSessionIds":[],"mutedSessionIds":["muted"],"unreadSessionIds":[],"pinnedGroupSpaceIds":[]});
    let request = |events, bootstrap, sequence| ChatSyncApplyRequest {
        account_id: "acct_test".into(),
        bootstrap,
        cursor: Some(format!("cursor-{sequence}")),
        last_stream_seq: Some(sequence),
        conversations: vec![],
        messages: vec![],
        events,
    };
    super::super::apply_on_connection(&mut conn, request(vec![json!({"protocol_version":2,"type":"session.visibility.snapshot","stream_seq":7,"payload":{"visibility":snapshot}})],true,7)).unwrap();
    let state = super::super::load_state(&conn, "acct_test").unwrap();
    assert_eq!(state.cursor.as_deref(), Some("cursor-7"));
    assert_eq!(state.visibility, Some(snapshot.clone()));
    assert!(load_visibility(&conn, "acct_other").unwrap().is_none());
    let invalid = request(
        vec![
            json!({"protocol_version":2,"type":"session.visibility.snapshot","stream_seq":8,"payload":{"visibility":{}}}),
        ],
        false,
        8,
    );
    assert!(super::super::apply_on_connection(&mut conn, invalid).is_err());
    assert_eq!(
        super::super::load_state(&conn, "acct_test")
            .unwrap()
            .cursor
            .as_deref(),
        Some("cursor-7")
    );
    assert_eq!(load_visibility(&conn, "acct_test").unwrap(), Some(snapshot));
    super::super::apply_on_connection(&mut conn, request(vec![json!({"protocol_version":2,"type":"session.unhidden","stream_seq":8,"payload":{"sessionId":"deleted"}})],false,8)).unwrap();
    assert_eq!(
        load_visibility(&conn, "acct_test").unwrap().unwrap()["deletedSessionIds"],
        json!([])
    );
}
