use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_121_adds_document_shares() {
    let pool = fixture(121).await;
    execute(&pool, "INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,content_type,size_bytes,created_at,finalized_at) VALUES('att-doc','fixture-owner','attachments/fixture-owner/att-doc','text/markdown',10,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    let before: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - 'document_source_attachment_id' FROM cloud_attachments a ORDER BY attachment_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let (a, b) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    a.unwrap();
    b.unwrap();
    latest_version(&pool).await;
    let after: Vec<(Value,)> =
        query_as("SELECT to_jsonb(a) - 'document_source_attachment_id' FROM cloud_attachments a ORDER BY attachment_id")
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
                "SELECT to_jsonb(t) FROM {table} t ORDER BY 1::text"
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
        "SELECT to_jsonb(a) - 'document_source_attachment_id', document_source_attachment_id \
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
