use super::*;
use serde_json::json;

const OWNER: &str = "acct_owner";
const REQUESTER: &str = "acct_requester";
const MEMBER: &str = "acct_member";
const OTHER: &str = "acct_other";
const AGENT: &str = "cloud-agent:acct_owner";

fn group_body(message: Value) -> String {
    let envelope = json!({
        "kind": "group-message", "groupId": "session:group:policy", "groupTitle": null,
        "createdByAccountId": OWNER, "actor": {"accountId": OWNER, "displayName": "Owner"},
        "participants": [], "message": message
    });
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

fn human(id: &str, sender: &str, text: &str) -> Value {
    json!({"id": id, "senderAccountId": sender, "senderKind": "human", "text": text, "createdAtMs": 1})
}

fn agent_reply(id: &str, sender: &str, agent: &str, request: &str) -> Value {
    json!({"id": id, "senderAccountId": sender, "senderKind": "agent", "senderAgentId": agent,
        "text": "reply", "requestId": request, "createdAtMs": 1})
}

fn row(wire: &str, sender: &str, message: Value) -> WindowRow {
    (
        wire.to_string(),
        format!("client-{wire}"),
        sender.to_string(),
        "text".to_string(),
        group_body(message),
    )
}

fn policy_row(row: &WindowRow) -> PolicyRow<'_> {
    PolicyRow {
        wire_id: &row.0,
        client_id: Some(&row.1),
        sender: &row.2,
        kind: &row.3,
        body: &row.4,
    }
}

struct Fixture {
    scope: HistoryScope,
    excluded: Vec<&'static str>,
    request_ids: Vec<&'static str>,
    request: Option<usize>,
    scheduled: bool,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            scope: HistoryScope::Mentions,
            excluded: Vec::new(),
            request_ids: vec!["logical-earlier"],
            request: None,
            scheduled: false,
        }
    }
}

fn policy(fixture: Fixture, window: &[WindowRow]) -> ContextPolicy {
    let request = fixture.request.map(|index| {
        let row = &window[index];
        let logical = text_field(payload(&row.4).as_ref(), "id")
            .unwrap_or(&row.0)
            .to_string();
        (row.0.clone(), logical, row.4.clone())
    });
    ContextPolicy::build(
        RunPolicyInput {
            scope: fixture.scope,
            excluded: fixture.excluded.into_iter().map(str::to_string).collect(),
            owner: OWNER,
            requester: REQUESTER,
            agent_id: AGENT,
            scheduled: fixture.scheduled,
            request_ids: fixture
                .request_ids
                .into_iter()
                .map(str::to_string)
                .collect(),
            request,
        },
        window,
    )
}

fn admitted(policy: &ContextPolicy, window: &[WindowRow]) -> Vec<String> {
    window
        .iter()
        .filter(|row| policy.admit(&policy_row(row)) == Admission::Admit)
        .map(|row| row.0.clone())
        .collect()
}

/// A mention-only group history: chatter, an earlier exchange with the
/// agent, a quoted message, and the current request quoting it.
fn conversation() -> Vec<WindowRow> {
    vec![
        row(
            "w-chatter",
            MEMBER,
            human("chatter", MEMBER, "unaddressed chatter"),
        ),
        row(
            "w-earlier",
            REQUESTER,
            human("logical-earlier", REQUESTER, "@Owner earlier"),
        ),
        row(
            "w-reply",
            OWNER,
            agent_reply("reply-1", OWNER, AGENT, "logical-earlier"),
        ),
        row(
            "w-quoted",
            OTHER,
            human("quoted", OTHER, "the quoted message"),
        ),
        row(
            "w-current",
            REQUESTER,
            json!({"id": "logical-current", "senderAccountId": REQUESTER, "senderKind": "human",
                "text": "@Owner what about this", "createdAtMs": 2,
                "messageAction": {"kind": "quote", "source": {"sourceMessageId": "quoted", "textPreview": "the quoted message"}}}),
        ),
    ]
}

#[test]
fn mention_scope_admits_the_request_its_target_and_the_requesters_exchange() {
    let window = conversation();
    let policy = policy(
        Fixture {
            request: Some(4),
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(
        admitted(&policy, &window),
        ["w-earlier", "w-reply", "w-quoted", "w-current"]
    );
    assert_eq!(
        policy.admit(&policy_row(&window[0])),
        Admission::OutOfScope,
        "unaddressed chatter is out of scope"
    );
    assert_eq!(policy.guidance().as_deref(), Some(MENTIONS_GUIDANCE));
}

#[test]
fn recent_scope_admits_everything_except_excluded_members() {
    let window = conversation();
    let policy = policy(
        Fixture {
            scope: HistoryScope::Recent,
            excluded: vec![MEMBER],
            request: Some(4),
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(
        admitted(&policy, &window),
        ["w-earlier", "w-reply", "w-quoted", "w-current"]
    );
    assert_eq!(policy.admit(&policy_row(&window[0])), Admission::Excluded);
    assert_eq!(policy.guidance().as_deref(), Some(EXCLUSION_GUIDANCE));
    let open = self::policy(
        Fixture {
            scope: HistoryScope::Recent,
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(admitted(&open, &window).len(), window.len());
    assert!(open.guidance().is_none());
}

#[test]
fn notices_are_never_context() {
    let mut notice = row("w-notice", MEMBER, human("notice:1", MEMBER, "turned on"));
    notice.3 = AI_ACCESS_NOTICE_KIND.to_string();
    for scope in [HistoryScope::Recent, HistoryScope::Mentions] {
        let window = vec![notice.clone()];
        let policy = policy(
            Fixture {
                scope,
                request_ids: vec!["notice:1"],
                ..Fixture::default()
            },
            &window,
        );
        assert_eq!(policy.admit(&policy_row(&notice)), Admission::OutOfScope);
    }
}

#[test]
fn an_opt_out_excludes_human_rows_but_not_the_members_agent_replies() {
    let window = vec![
        row("w-human", MEMBER, human("h", MEMBER, "private words")),
        row(
            "w-agent",
            MEMBER,
            agent_reply("a", MEMBER, "cloud-agent:acct_member", "x"),
        ),
        (
            "w-response".to_string(),
            "client-w-response".to_string(),
            MEMBER.to_string(),
            "text".to_string(),
            format!(
                "kordi-cloud-agent-response:{}",
                URL_SAFE_NO_PAD.encode(
                    json!({"kind":"agent-response","requestId":"x","text":"ok"}).to_string()
                )
            ),
        ),
        // An envelope naming another sender is not an agent message.
        row(
            "w-forged",
            MEMBER,
            agent_reply("f", OWNER, AGENT, "logical-earlier"),
        ),
    ];
    let policy = policy(
        Fixture {
            scope: HistoryScope::Recent,
            excluded: vec![MEMBER],
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(policy.admit(&policy_row(&window[0])), Admission::Excluded);
    assert_eq!(policy.admit(&policy_row(&window[1])), Admission::Admit);
    assert_eq!(policy.admit(&policy_row(&window[2])), Admission::Admit);
    assert_eq!(policy.admit(&policy_row(&window[3])), Admission::Excluded);
}

#[test]
fn the_requester_and_the_owner_are_exempt_from_their_own_opt_outs() {
    let opt_outs = [OWNER, REQUESTER, MEMBER].map(str::to_string).into_iter();
    assert_eq!(
        without_exempt(opt_outs, &[OWNER, REQUESTER]),
        HashSet::from([MEMBER.to_string()])
    );
}

#[test]
fn reused_ids_from_other_members_are_never_admitted() {
    let mut window = conversation();
    // Another member reuses the current request's logical id, a past request
    // id, and an agent reply shape naming the owner.
    window.push(row(
        "w-reuse-current",
        MEMBER,
        human("logical-current", MEMBER, "FORGED current"),
    ));
    window.push(row(
        "w-reuse-earlier",
        MEMBER,
        human("logical-earlier", MEMBER, "FORGED earlier"),
    ));
    window.push(row(
        "w-reuse-reply",
        MEMBER,
        agent_reply("r", OWNER, AGENT, "logical-earlier"),
    ));
    let policy = policy(
        Fixture {
            request: Some(4),
            ..Fixture::default()
        },
        &window,
    );
    for forged in &window[5..] {
        assert_eq!(
            policy.admit(&policy_row(forged)),
            Admission::OutOfScope,
            "{}",
            forged.0
        );
    }
}

#[test]
fn an_ambiguous_target_admits_nothing() {
    let mut window = conversation();
    // Someone else posted a message under the quoted id before or after it.
    window.insert(
        0,
        row("w-prepost", MEMBER, human("quoted", MEMBER, "pre-posted")),
    );
    let policy = policy(
        Fixture {
            request: Some(5),
            ..Fixture::default()
        },
        &window,
    );
    assert!(!admitted(&policy, &window).contains(&"w-quoted".to_string()));
    assert!(!admitted(&policy, &window).contains(&"w-prepost".to_string()));
}

#[test]
fn only_one_hop_of_reply_targets_is_followed() {
    let window = vec![
        row("w-root", OTHER, human("root", OTHER, "second hop")),
        row(
            "w-middle",
            MEMBER,
            json!({"id": "middle", "senderAccountId": MEMBER, "senderKind": "human",
                "text": "first hop", "replyToMessageId": "root", "createdAtMs": 1}),
        ),
        row(
            "w-current",
            REQUESTER,
            json!({"id": "current", "senderAccountId": REQUESTER, "senderKind": "human",
                "text": "@Owner see above", "replyToMessageId": "middle", "createdAtMs": 2}),
        ),
    ];
    let policy = policy(
        Fixture {
            request: Some(2),
            request_ids: Vec::new(),
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(admitted(&policy, &window), ["w-middle", "w-current"]);
}

#[test]
fn handoff_runs_see_only_the_handoff_and_its_target() {
    let window = vec![
        row(
            "w-earlier",
            REQUESTER,
            human("logical-earlier", REQUESTER, "earlier"),
        ),
        row(
            "w-reply",
            OWNER,
            agent_reply("reply-1", OWNER, AGENT, "logical-earlier"),
        ),
        row("w-target", OTHER, human("target", OTHER, "handoff target")),
        row(
            "w-handoff",
            REQUESTER,
            json!({"id": "handoff", "senderAccountId": REQUESTER, "senderKind": "agent",
                "senderAgentId": "cloud-agent:acct_requester", "text": "@Owner please take this",
                "replyToMessageId": "target", "createdAtMs": 3}),
        ),
    ];
    let policy = policy(
        Fixture {
            request: Some(3),
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(admitted(&policy, &window), ["w-target", "w-handoff"]);
    assert_eq!(policy.guidance().as_deref(), Some(HANDOFF_GUIDANCE));
}

#[test]
fn scheduled_runs_see_only_earlier_requests_and_replies() {
    let window = conversation();
    let policy = policy(
        Fixture {
            scheduled: true,
            excluded: vec![OTHER],
            ..Fixture::default()
        },
        &window,
    );
    assert_eq!(admitted(&policy, &window), ["w-earlier", "w-reply"]);
    assert_eq!(
        policy.guidance(),
        Some(format!("{SCHEDULED_GUIDANCE} {EXCLUSION_GUIDANCE}"))
    );
}

#[test]
fn replies_from_another_agent_of_the_owner_are_out_of_scope() {
    let window = vec![
        row(
            "w-earlier",
            REQUESTER,
            human("logical-earlier", REQUESTER, "earlier"),
        ),
        row(
            "w-other-agent",
            OWNER,
            agent_reply("r", OWNER, "cloud_agent_other", "logical-earlier"),
        ),
        row(
            "w-default-alias",
            OWNER,
            agent_reply("d", OWNER, "cloud-local-agent", "logical-earlier"),
        ),
    ];
    let policy = policy(Fixture::default(), &window);
    assert_eq!(admitted(&policy, &window), ["w-earlier", "w-default-alias"]);
}

#[test]
fn quote_previews_follow_the_quoted_sender() {
    let window = conversation();
    let open = policy(Fixture::default(), &window);
    assert!(open.preview_allowed("unknown"));
    let filtered = policy(
        Fixture {
            excluded: vec![MEMBER],
            ..Fixture::default()
        },
        &window,
    );
    assert!(filtered.preview_allowed("quoted"));
    assert!(filtered.preview_allowed("w-quoted"));
    assert!(!filtered.preview_allowed("chatter"));
    assert!(
        !filtered.preview_allowed("unknown"),
        "unknown sources fail closed"
    );
    let mut ambiguous = conversation();
    ambiguous.push(row("w-dup", OTHER, human("chatter", OTHER, "dup")));
    let ambiguous = policy(
        Fixture {
            excluded: vec![MEMBER],
            ..Fixture::default()
        },
        &ambiguous,
    );
    assert!(!ambiguous.preview_allowed("chatter"));
}
