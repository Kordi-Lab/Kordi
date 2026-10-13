//! Comment threads as agents see them: plain names, bodies, and whether an
//! agent wrote the comment. No account ids or reader keys.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThreadComment {
    pub comment_id: String,
    pub block_id: String,
    pub parent_comment_id: Option<String>,
    pub author: String,
    pub by_agent: bool,
    pub body: String,
    pub created_at: String,
    pub resolved: bool,
}

impl ThreadComment {
    /// The comment that starts this comment's thread.
    pub(crate) fn root_id(&self) -> &str {
        self.parent_comment_id
            .as_deref()
            .unwrap_or(&self.comment_id)
    }
}

type ThreadRow = (
    String,
    String,
    Option<String>,
    String,
    bool,
    String,
    String,
    bool,
);

/// Undeleted comments on the document, oldest first.
pub(crate) async fn load_comments(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<Vec<ThreadComment>, sqlx_core::Error> {
    let rows: Vec<ThreadRow> = query_as(
        "SELECT comment.comment_id, comment.block_id, comment.parent_comment_id, \
                COALESCE(comment.author_agent_name, NULLIF(btrim(account.display_name), ''), \
                         comment.author_name), \
                comment.author_agent_id IS NOT NULL, comment.body, comment.created_at, \
                comment.resolved_at IS NOT NULL \
         FROM cloud_document_comments comment \
         LEFT JOIN cloud_accounts account ON account.account_id = comment.author_account_id \
         WHERE comment.attachment_id = $1 AND comment.deleted_at IS NULL \
         ORDER BY comment.created_at ASC, comment.comment_id ASC",
    )
    .bind(attachment_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(comment_id, block_id, parent, author, by_agent, body, created_at, resolved)| {
                ThreadComment {
                    comment_id,
                    block_id,
                    parent_comment_id: parent,
                    author,
                    by_agent,
                    body,
                    created_at,
                    resolved,
                }
            },
        )
        .collect())
}

/// The comments of the thread `root_id` starts, oldest first.
pub(crate) fn thread_of<'a>(
    comments: &'a [ThreadComment],
    root_id: &str,
) -> Vec<&'a ThreadComment> {
    comments
        .iter()
        .filter(|comment| comment.root_id() == root_id)
        .collect()
}

/// Unresolved threads in document order of their first comment, as the
/// `read_document` tool returns them.
pub(crate) fn open_threads(comments: &[ThreadComment]) -> Vec<Value> {
    comments
        .iter()
        .filter(|comment| comment.parent_comment_id.is_none() && !comment.resolved)
        .map(|root| {
            let entries: Vec<Value> = thread_of(comments, &root.comment_id)
                .into_iter()
                .map(|comment| {
                    json!({
                        "commentId": comment.comment_id,
                        "author": comment.author,
                        "byAgent": comment.by_agent,
                        "body": comment.body,
                        "createdAt": comment.created_at,
                    })
                })
                .collect();
            json!({ "blockId": root.block_id, "comments": entries })
        })
        .collect()
}
