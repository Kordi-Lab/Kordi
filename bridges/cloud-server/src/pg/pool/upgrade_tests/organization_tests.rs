use super::*;

const OWNED: [(&str, &str); 6] = [
    ("cloud_chat_conversations", "created_by_account_id"),
    ("cloud_agent_definitions", "owner_account_id"),
    ("cloud_agent_fallback_runs", "owner_account_id"),
    ("scheduled_tool_tasks", "owner_account_id"),
    ("scheduled_tool_task_runs", "owner_account_id"),
    ("cloud_attachments", "owner_account_id"),
];

async fn seed_owned_rows(pool: &PgPool, suffix: &str, owner: &str) {
    execute(pool, &format!("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint) VALUES(gen_random_uuid(),'group','{owner}',gen_random_uuid(),'fixture')")).await;
    execute(pool, &format!("INSERT INTO cloud_agent_definitions(agent_id,owner_account_id,name,role,system_prompt,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('agent-{suffix}','{owner}','Helper','helper','Help.','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','thumbs','agent-{suffix}','fixture',1,'2026-01-01T00:00:00Z')")).await;
    execute(pool, &format!("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES('run-{suffix}','run-{suffix}','run-{suffix}','session-fixture','{owner}','fixture-peer','completed','{{}}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")).await;
    execute(pool, &format!("INSERT INTO scheduled_tool_tasks(task_id,owner_account_id,created_by_account_id,title,prompt,schedule_json,target_runtime,status,created_at,updated_at) VALUES('task-{suffix}','{owner}','{owner}','Check','Check.','{{}}','cloud','active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")).await;
    execute(pool, &format!("INSERT INTO scheduled_tool_task_runs(run_id,task_id,owner_account_id,status,target_runtime,due_at,created_at,updated_at) VALUES('taskrun-{suffix}','task-{suffix}','{owner}','queued','cloud','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')")).await;
    execute(pool, &format!("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at) VALUES('att-{suffix}','{owner}','attachments/{owner}/att-{suffix}','2026-01-01T00:00:00Z')")).await;
}

/// Per owned table: rows whose organization is not their owner's personal one.
async fn misattributed(pool: &PgPool) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    for (table, column) in OWNED {
        let (count,): (i64,) = query_as(&format!(
            "SELECT count(*) FROM {table} r WHERE r.organization_id IS DISTINCT FROM \
             (SELECT organization_id FROM cloud_organizations WHERE personal_account_id = r.{column})"
        ))
        .fetch_one(pool)
        .await
        .unwrap();
        out.push((table.to_string(), count));
    }
    out
}

async fn organization_snapshot(pool: &PgPool) -> Value {
    let (value,): (Value,) = query_as("SELECT jsonb_build_object('organizations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY organization_id) FROM cloud_organizations o),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY organization_id,account_id) FROM cloud_organization_members m))")
        .fetch_one(pool)
        .await
        .unwrap();
    value
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_161_adds_personal_organizations_and_ownership() {
    let pool = fixture(161).await;
    seed_owned_rows(&pool, "owner", "fixture-owner").await;
    seed_owned_rows(&pool, "peer", "fixture-peer").await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    let personal: Vec<(String, String, String, String)> = query_as(
        "SELECT o.personal_account_id, o.kind, o.name, m.role FROM cloud_organizations o \
         JOIN cloud_organization_members m ON m.organization_id = o.organization_id \
         ORDER BY o.personal_account_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        personal,
        ["fixture-owner", "fixture-peer"]
            .map(|id| (
                id.to_string(),
                "personal".to_string(),
                "Personal".to_string(),
                "owner".to_string()
            ))
            .to_vec(),
        "one personal organization per account, owned by it"
    );
    assert!(misattributed(&pool).await.iter().all(|(_, n)| *n == 0));
    let (updated,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE updated_at <> '2026-01-01T00:00:00Z'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(updated, 0, "the backfill leaves timestamps alone");

    // Running the released SQL again changes nothing.
    let before = organization_snapshot(&pool).await;
    for version in [162, 163, 164] {
        let migration = EMBEDDED_MIGRATIONS
            .iter()
            .find(|m| m.version == version)
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx_core::raw_sql::raw_sql(migration.sql)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    assert_eq!(organization_snapshot(&pool).await, before);

    // A new account, and rows written by a replica that does not know the
    // column, still get a personal organization.
    execute(&pool, "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('fixture-new','New','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','generated','lorelei','fixture-new','fixture',1,'2026-01-02T00:00:00Z')").await;
    seed_owned_rows(&pool, "new", "fixture-new").await;
    assert!(misattributed(&pool).await.iter().all(|(_, n)| *n == 0));
    let (organizations, members): (i64, i64) = query_as(
        "SELECT (SELECT count(*) FROM cloud_organizations), \
                (SELECT count(*) FROM cloud_organization_members)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((organizations, members), (3, 3));

    let second = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_organizations(organization_id,name,kind,personal_account_id) VALUES('org_second','Second','personal','fixture-new')",
    )
    .execute(&pool)
    .await;
    assert!(second.is_err(), "one personal organization per account");
    let team_with_owner = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_organizations(organization_id,name,kind,personal_account_id) VALUES('org_team','Team','team','fixture-new')",
    )
    .execute(&pool)
    .await;
    assert!(
        team_with_owner.is_err(),
        "only personal organizations name an account"
    );
    let joined = sqlx_core::raw_sql::raw_sql(
        "INSERT INTO cloud_organization_members(organization_id,account_id,role) SELECT organization_id,'fixture-peer','member' FROM cloud_organizations WHERE personal_account_id='fixture-owner'",
    )
    .execute(&pool)
    .await;
    assert!(
        joined.is_err(),
        "a personal organization has only its owner"
    );
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_165_adds_organization_selection() {
    let pool = fixture(165).await;
    seed_owned_rows(&pool, "owner", "fixture-owner").await;
    let before = organization_snapshot(&pool).await;
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;

    assert_eq!(
        misattributed(&pool)
            .await
            .iter()
            .map(|(_, n)| n)
            .sum::<i64>(),
        0
    );
    let (rule, expiring, invitations): (i64, i64, i64) = query_as(
        "SELECT (SELECT count(*) FROM cloud_organizations WHERE member_owned_content), \
                (SELECT count(*) FROM cloud_organization_members WHERE expires_at IS NOT NULL), \
                (SELECT count(*) FROM cloud_organization_invitations)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((rule, expiring, invitations), (0, 0, 0));
    let mut after = organization_snapshot(&pool).await;
    for organization in after["organizations"].as_array_mut().unwrap() {
        organization
            .as_object_mut()
            .unwrap()
            .remove("member_owned_content");
    }
    for member in after["members"].as_array_mut().unwrap() {
        member.as_object_mut().unwrap().remove("expires_at");
    }
    assert_eq!(
        after, before,
        "existing organizations and members are unchanged"
    );

    // A run queued after the upgrade is still charged to the agent owner.
    seed_owned_rows(&pool, "later", "fixture-peer").await;
    assert_eq!(
        misattributed(&pool)
            .await
            .iter()
            .map(|(_, n)| n)
            .sum::<i64>(),
        0
    );
}
