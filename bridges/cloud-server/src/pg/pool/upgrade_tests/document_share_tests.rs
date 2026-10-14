use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_121_adds_document_shares() {
    let pool = fixture(121).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - ARRAY['document_source_attachment_id','document_title'] FROM cloud_attachments a ORDER BY attachment_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - ARRAY['document_source_attachment_id','document_title'] FROM cloud_attachments a ORDER BY attachment_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "attachments are untouched");

    execute(&pool, "INSERT INTO cloud_document_shares(share_id,token_hash,attachment_id,owner_account_id,created_at) VALUES('docshare_live','hash-live','att-doc','fixture-owner','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_shares(share_id,token_hash,attachment_id,owner_account_id,created_at,revoked_at) VALUES('docshare_old','hash-old','att-doc','fixture-owner','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at) VALUES('rx-account','att-doc','b0','\u{1f44d}','fixture-peer','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_reader_key,actor_name,created_at) VALUES('rx-reader','att-doc','b0','\u{1f44d}','reader-key-0123456789','Priya','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at,deleted_at) VALUES('rx-gone','att-doc','b0','\u{1f44d}','fixture-peer','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_root','att-doc','b1','fixture-peer','Peer','Root','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,parent_comment_id,author_reader_key,author_name,body,mentions_agent,created_at) VALUES('doccmt_reply','att-doc','b1','doccmt_root','reader-key-0123456789','Priya','@agent why?',true,'2026-01-02T00:01:00Z')").await;
    for invalid in [
        // A second live share for the same owner and document.
        "INSERT INTO cloud_document_shares(share_id,token_hash,attachment_id,owner_account_id,created_at) VALUES('docshare_dup','hash-dup','att-doc','fixture-owner','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_shares(share_id,token_hash,attachment_id,owner_account_id,created_at) VALUES('share_bad','hash-bad','att-doc','fixture-peer','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_shares(share_id,token_hash,attachment_id,owner_account_id,access_mode,created_at) VALUES('docshare_mode','hash-mode','att-doc','fixture-peer','public','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at) VALUES('rx-dup','att-doc','b0','\u{1f44d}','fixture-peer','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_reader_key,created_at) VALUES('rx-noname','att-doc','b0','\u{1f525}','reader-key-0123456789','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at) VALUES('rx-block','att-doc','x1','\u{1f525}','fixture-peer','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_name,body,created_at) VALUES('doccmt_anon','att-doc','b1','Nobody','x','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_empty','att-doc','b1','fixture-peer','Peer','','2026-01-03T00:00:00Z')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }

    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-peer'",
    )
    .await;
    let (reactions, comments): (i64, i64) = query_as("SELECT (SELECT COUNT(*) FROM cloud_document_reactions)::BIGINT, (SELECT COUNT(*) FROM cloud_document_comments)::BIGINT")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (reactions, comments),
        (1, 0),
        "a deleted account takes its reactions and threads"
    );
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    for table in [
        "cloud_document_shares",
        "cloud_document_reactions",
        "cloud_document_comments",
    ] {
        let (rows,): (i64,) = query_as(&format!("SELECT COUNT(*)::BIGINT FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{table} rows go with the document");
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_122_adds_document_contents() {
    let pool = fixture(122).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_shares(share_id,token_hash,attachment_id,owner_account_id,created_at) VALUES('docshare_live','hash-live','att-doc','fixture-owner','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_root','att-doc','b1','fixture-peer','Peer','Root','2026-01-02T00:00:00Z')").await;
    let snapshot = |table: &'static str| {
        let pool = pool.clone();
        async move {
            query_as::<_, (Value,)>(&format!(
                "SELECT to_jsonb(t) - ARRAY['author_agent_id','author_agent_name'] \
                 FROM {table} t ORDER BY 1::text"
            ))
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    let before = (
        snapshot("cloud_document_shares").await,
        snapshot("cloud_document_comments").await,
    );
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after = (
        snapshot("cloud_document_shares").await,
        snapshot("cloud_document_comments").await,
    );
    assert_eq!(before, after, "shares and threads are untouched");
    let (contents,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_document_contents")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        contents, 0,
        "sources are copied on first read, not by the migration"
    );

    execute(&pool, "INSERT INTO cloud_document_contents(attachment_id,source,updated_by_account_id,updated_at) VALUES('att-doc','# Notes','fixture-peer','2026-01-03T00:00:00Z')").await;
    let (revision,): (i64,) =
        query_as("SELECT revision FROM cloud_document_contents WHERE attachment_id='att-doc'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(revision, 1);
    for invalid in [
        "INSERT INTO cloud_document_contents(attachment_id,source,updated_at) VALUES('att-doc','dup','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_contents(attachment_id,source,updated_at) VALUES('missing','x','2026-01-03T00:00:00Z')",
        "UPDATE cloud_document_contents SET revision=0 WHERE attachment_id='att-doc'",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-peer'",
    )
    .await;
    let (editor,): (Option<String>,) = query_as(
        "SELECT updated_by_account_id FROM cloud_document_contents WHERE attachment_id='att-doc'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(editor, None, "a deleted editor leaves the source in place");
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    let (left,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_document_contents")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0, "the source goes with its attachment");
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_123_adds_document_sources() {
    let pool = fixture(123).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('att-copy','fixture-peer','attachments/fixture-peer/att-copy','text/markdown',10,'2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) FROM cloud_attachments a ORDER BY attachment_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value, Option<String>)> = query_as(
        "SELECT to_jsonb(a) - ARRAY['document_source_attachment_id','document_title'], \
                document_source_attachment_id \
         FROM cloud_attachments a ORDER BY attachment_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        before.into_iter().map(|(row,)| row).collect::<Vec<_>>(),
        after.iter().map(|(row, _)| row.clone()).collect::<Vec<_>>(),
        "existing attachments keep every value"
    );
    assert!(
        after.iter().all(|(_, source)| source.is_none()),
        "no copy is linked by the migration"
    );

    execute(&pool, "UPDATE cloud_attachments SET document_source_attachment_id='att-doc' WHERE attachment_id='att-copy'").await;
    assert!(sqlx_core::raw_sql::raw_sql("UPDATE cloud_attachments SET document_source_attachment_id='missing' WHERE attachment_id='att-copy'").execute(&pool).await.is_err());
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    let (source,): (Option<String>,) = query_as(
        "SELECT document_source_attachment_id FROM cloud_attachments WHERE attachment_id='att-copy'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        source, None,
        "a deleted source leaves the copy as its own document"
    );
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_124_relaxes_block_ids() {
    let pool = fixture(124).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at) VALUES('rx-old','att-doc','b2','\u{1f44d}','fixture-peer','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_old','att-doc','b3','fixture-peer','Peer','Old','2026-01-02T00:00:00Z')").await;
    assert!(sqlx_core::raw_sql::raw_sql("INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_early','att-doc','k:abcd','fixture-peer','Peer','x','2026-01-02T00:00:00Z')").execute(&pool).await.is_err(), "stable ids need migration 125");
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let (reaction, comment): (String, String) = query_as(
        "SELECT (SELECT block_id FROM cloud_document_reactions WHERE reaction_id='rx-old'), \
                (SELECT block_id FROM cloud_document_comments WHERE comment_id='doccmt_old')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (reaction.as_str(), comment.as_str()),
        ("b2", "b3"),
        "existing ids are kept"
    );
    execute(&pool, "INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at) VALUES('rx-new','att-doc','k:7f3a9c2d','\u{1f44d}','fixture-peer','2026-01-03T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_new','att-doc','k:A-b_9','fixture-peer','Peer','New','2026-01-03T00:00:00Z')").await;
    for invalid in ["k:abc", "k:a b c d", "x1", "b123456"] {
        for sql in [
            format!("INSERT INTO cloud_document_reactions(reaction_id,attachment_id,block_id,reaction,actor_account_id,created_at) VALUES('rx-bad','att-doc','{invalid}','\u{1f525}','fixture-peer','2026-01-03T00:00:00Z')"),
            format!("INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,created_at) VALUES('doccmt_bad','att-doc','{invalid}','fixture-peer','Peer','x','2026-01-03T00:00:00Z')"),
        ] {
            assert!(sqlx_core::raw_sql::raw_sql(&sql).execute(&pool).await.is_err(), "{sql}");
        }
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_125_adds_document_collab() {
    let pool = fixture(125).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_contents(attachment_id,source,updated_at) VALUES('att-doc','# Notes','2026-01-02T00:00:00Z')").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(c) - 'updated_by_agent_id' FROM cloud_document_contents c")
            .fetch_all(&pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(c) - 'updated_by_agent_id' FROM cloud_document_contents c")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(before, after, "document sources are untouched");
    let (rooms,): (i64,) = query_as("SELECT COUNT(*)::BIGINT FROM cloud_document_collab")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rooms, 0, "rooms are created on first use");

    execute(
        &pool,
        "INSERT INTO cloud_document_collab(attachment_id) VALUES('att-doc')",
    )
    .await;
    let (seq, state, stale, initialized): (i64, Vec<u8>, bool, bool) = query_as(
        "SELECT seq, state, stale_revision, initialized_at IS NOT NULL FROM cloud_document_collab",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((seq, state.len(), stale, initialized), (0, 0, false, false));
    execute(&pool, "INSERT INTO cloud_document_collab_updates(attachment_id,seq,update) VALUES('att-doc',1,'\\x0000')").await;
    execute(&pool, "INSERT INTO cloud_document_collab_tickets(ticket_hash,attachment_id,requested_attachment_id,account_id,device_id,session_token_id,expires_at) VALUES('hash','att-doc','att-doc','fixture-peer','dev','tok',now())").await;
    for invalid in [
        "INSERT INTO cloud_document_collab_updates(attachment_id,seq,update) VALUES('att-doc',1,'\\x00')",
        "INSERT INTO cloud_document_collab_updates(attachment_id,seq,update) VALUES('att-doc',0,'\\x00')",
        "INSERT INTO cloud_document_collab_updates(attachment_id,seq,update) VALUES('missing',2,'\\x00')",
        "UPDATE cloud_document_collab SET seq=-1",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-peer'",
    )
    .await;
    execute(
        &pool,
        "DELETE FROM cloud_accounts WHERE account_id='fixture-owner'",
    )
    .await;
    for table in [
        "cloud_document_collab",
        "cloud_document_collab_updates",
        "cloud_document_collab_tickets",
    ] {
        let (rows,): (i64,) = query_as(&format!("SELECT COUNT(*)::BIGINT FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{table} rows go with the document");
    }
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_126_adds_document_agent_runs() {
    let pool = fixture(126).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_contents(attachment_id,source,updated_by_account_id,updated_at) VALUES('att-doc','# Notes','fixture-owner','2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,mentions_agent,created_at) VALUES('doccmt_ask','att-doc','b0','fixture-peer','Peer','@Kordi shorter?',true,'2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_reader_key,author_name,body,created_at) VALUES('doccmt_reader','att-doc','b0','reader-key-0123456789','Priya','Nice','2026-01-02T00:01:00Z')").await;
    execute(&pool, "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES('car_old','key-old','msg-old','session:one','fixture-owner','fixture-owner','completed','Hello','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let comments_before: Vec<(Value,)> = query_as(
        "SELECT to_jsonb(c) - ARRAY['author_agent_id','author_agent_name'] FROM cloud_document_comments c ORDER BY comment_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let runs_before = historical_runs(&pool).await;
    assert!(sqlx_core::raw_sql::raw_sql("INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_agent_id,author_agent_name,author_name,body,created_at) VALUES('doccmt_early','att-doc','b0','cloud-agent:fixture-owner','Kordi','Kordi','x','2026-01-02T00:00:00Z')").execute(&pool).await.is_err(), "agent authors need migration 127");
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let comments_after: Vec<(Value,)> = query_as(
        "SELECT to_jsonb(c) - ARRAY['author_agent_id','author_agent_name'] FROM cloud_document_comments c ORDER BY comment_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(comments_before, comments_after, "comments are untouched");
    assert_eq!(
        runs_before,
        historical_runs(&pool).await,
        "runs are untouched"
    );
    let (run_comment, edited_by): (Option<String>, Option<String>) = query_as(
        "SELECT (SELECT document_comment_id FROM cloud_agent_fallback_runs WHERE run_id='car_old'), \
                (SELECT updated_by_agent_id FROM cloud_document_contents WHERE attachment_id='att-doc')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (run_comment, edited_by),
        (None, None),
        "new columns start empty"
    );

    execute(&pool, "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,document_comment_id) VALUES('car_doc','key-doc','doccmt:doccmt_ask','session:one','fixture-owner','fixture-peer','queued','Hello','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','doccmt_ask')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,parent_comment_id,author_agent_id,author_agent_name,author_name,body,created_at) VALUES('doccmt_agent','att-doc','b0','doccmt_ask','cloud-agent:fixture-owner','Kordi','Kordi','Shorter now.','2026-01-02T00:02:00Z')").await;
    execute(&pool, "UPDATE cloud_document_contents SET updated_by_agent_id='cloud-agent:fixture-owner' WHERE attachment_id='att-doc'").await;
    for invalid in [
        // No author, two authors, and an agent without a name.
        "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_name,body,created_at) VALUES('doccmt_none','att-doc','b0','Nobody','x','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_agent_id,author_agent_name,author_name,body,created_at) VALUES('doccmt_two','att-doc','b0','fixture-peer','cloud-agent:fixture-peer','Kordi','Peer','x','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_reader_key,author_agent_id,author_agent_name,author_name,body,created_at) VALUES('doccmt_mix','att-doc','b0','reader-key-0123456789','cloud-agent:fixture-peer','Kordi','Priya','x','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_agent_id,author_name,body,created_at) VALUES('doccmt_unnamed','att-doc','b0','cloud-agent:fixture-peer','Kordi','x','2026-01-03T00:00:00Z')",
        "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,document_comment_id) VALUES('car_bad','key-bad','doccmt:doccmt_missing','session:one','fixture-owner','fixture-peer','queued','Hello','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','doccmt_missing')",
    ] {
        assert!(sqlx_core::raw_sql::raw_sql(invalid).execute(&pool).await.is_err(), "{invalid}");
    }

    // A removed comment takes its replies; the run keeps its history.
    execute(
        &pool,
        "DELETE FROM cloud_document_comments WHERE comment_id='doccmt_ask'",
    )
    .await;
    let (comments, run_comment, run_request): (i64, Option<String>, String) = query_as(
        "SELECT (SELECT COUNT(*) FROM cloud_document_comments)::BIGINT, document_comment_id, \
                request_message_id FROM cloud_agent_fallback_runs WHERE run_id='car_doc'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (comments, run_comment, run_request.as_str()),
        (1, None, "doccmt:doccmt_ask")
    );
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_127_adds_desktop_preference() {
    let pool = fixture(127).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_document_comments(comment_id,attachment_id,block_id,author_account_id,author_name,body,mentions_agent,created_at) VALUES('doccmt_ask','att-doc','b0','fixture-peer','Peer','@Kordi shorter?',true,'2026-01-02T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES('car_old','key-old','msg-old','session:one','fixture-owner','fixture-owner','completed','Hello','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(&pool, "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,document_comment_id) VALUES('car_doc','key-doc','doccmt:doccmt_ask','session:one','fixture-owner','fixture-peer','queued','Hello','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','doccmt_ask')").await;
    let runs_before = historical_runs(&pool).await;
    assert!(
        sqlx_core::raw_sql::raw_sql(
            "UPDATE cloud_agent_fallback_runs SET desktop_preferred_until = now()"
        )
        .execute(&pool)
        .await
        .is_err(),
        "the desktop preference needs migration 128"
    );
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    assert_eq!(
        runs_before,
        historical_runs(&pool).await,
        "runs are untouched"
    );
    // Runs queued before the upgrade stay leasable by the cloud at once.
    let (waiting,): (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_fallback_runs \
         WHERE desktop_preferred_until IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(waiting, 0, "the new column starts empty");

    execute(&pool, "UPDATE cloud_agent_fallback_runs SET desktop_preferred_until = now() + interval '35 seconds' WHERE run_id='car_doc'").await;
    let (held, free): (i64, i64) = query_as(
        "SELECT COUNT(*) FILTER (WHERE desktop_preferred_until > now())::BIGINT, \
                COUNT(*) FILTER (WHERE desktop_preferred_until IS NULL)::BIGINT \
         FROM cloud_agent_fallback_runs",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((held, free), (1, 1));
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_128_adds_document_title() {
    let pool = fixture(128).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let snapshot =
        "SELECT to_jsonb(a) - 'document_title' FROM cloud_attachments a ORDER BY attachment_id";
    let before: Vec<(Value,)> = query_as(snapshot).fetch_all(&pool).await.unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> = query_as(snapshot).fetch_all(&pool).await.unwrap();
    assert_eq!(before, after, "attachments keep every value");
    let (title,): (Option<String>,) =
        query_as("SELECT document_title FROM cloud_attachments WHERE attachment_id='att-doc'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title, None, "titles start from the document");
    execute(
        &pool,
        "UPDATE cloud_attachments SET document_title='Q4 plan' WHERE attachment_id='att-doc'",
    )
    .await;
}
