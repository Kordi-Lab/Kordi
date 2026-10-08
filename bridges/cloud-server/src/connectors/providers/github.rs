//! GitHub: notifications, pull request state, and issue or pull request
//! comments.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::http::{
    cap_text, is_plain_identifier, list_at, required_str, text_at, ProviderHttp, MAX_TEXT_CHARS,
};
use super::{
    ConnectorHooks, ConnectorSecret, ConnectorToolDescriptor, OAuth2ConnectorProvider, PolledEvent,
    ProviderError, ServiceAdapter, ServiceProvider, GITHUB,
};
use crate::connectors::models::ConnectorToolGroup;

pub const API_BASE: &str = "https://api.github.com";
const HEADERS: &[(&str, &str)] = &[
    ("accept", "application/vnd.github+json"),
    ("user-agent", "kordi-cloud-server"),
    ("x-github-api-version", "2022-11-28"),
];
const MAX_COMMENT_CHARS: usize = 10_000;

pub const NOTIFICATIONS: &str = "github_notifications";
pub const PULL_REQUEST: &str = "github_pull_request";
pub const COMMENT: &str = "github_comment";

static TOOLS: [ConnectorToolDescriptor; 3] = [
    ConnectorToolDescriptor {
        name: NOTIFICATIONS,
        group: ConnectorToolGroup::Read,
        description: "List your GitHub notifications, newest first (at most 50).",
    },
    ConnectorToolDescriptor {
        name: PULL_REQUEST,
        group: ConnectorToolGroup::Read,
        description: "Read a pull request: state, reviews, and a summary of its checks.",
    },
    ConnectorToolDescriptor {
        name: COMMENT,
        group: ConnectorToolGroup::Act,
        description: "Comment on an issue or pull request as you.",
    },
];

pub fn input_schema(tool: &str) -> Option<Value> {
    let repo_fields = json!({
        "owner": { "type": "string", "description": "Repository owner." },
        "repo": { "type": "string", "description": "Repository name." },
        "number": { "type": "integer", "minimum": 1, "description": "Issue or pull request number." }
    });
    Some(match tool {
        NOTIFICATIONS => json!({
            "type": "object",
            "properties": {
                "all": { "type": "boolean", "description": "Include read notifications." },
                "participating": { "type": "boolean", "description": "Only threads you participate in." }
            },
            "additionalProperties": false
        }),
        PULL_REQUEST => json!({
            "type": "object",
            "properties": repo_fields,
            "required": ["owner", "repo", "number"],
            "additionalProperties": false
        }),
        COMMENT => {
            let mut properties = repo_fields;
            properties["body"] = json!({ "type": "string", "maxLength": MAX_COMMENT_CHARS });
            json!({
                "type": "object",
                "properties": properties,
                "required": ["owner", "repo", "number", "body"],
                "additionalProperties": false
            })
        }
        _ => return None,
    })
}

pub struct GithubAdapter {
    api: ProviderHttp,
}

pub fn provider(http: reqwest::Client, api_base: Option<String>) -> ServiceProvider<GithubAdapter> {
    ServiceProvider::new(
        OAuth2ConnectorProvider::new(&GITHUB, http.clone()),
        GithubAdapter {
            api: ProviderHttp::new(http, api_base.unwrap_or_else(|| API_BASE.into()), HEADERS),
        },
    )
}

struct RepoRef<'a> {
    owner: &'a str,
    repo: &'a str,
    number: u64,
}

fn repo_ref(args: &Value) -> Result<RepoRef<'_>, ProviderError> {
    let owner = required_str(args, "owner", 100)?;
    let repo = required_str(args, "repo", 100)?;
    if !is_plain_identifier(owner) || !is_plain_identifier(repo) {
        return Err(ProviderError::invalid(
            "owner and repo may contain only letters, digits, '.', '_', and '-'.",
        ));
    }
    let number = args
        .get("number")
        .and_then(Value::as_u64)
        .filter(|number| (1..=1_000_000_000).contains(number))
        .ok_or_else(|| ProviderError::invalid("number must be a positive integer."))?;
    Ok(RepoRef {
        owner,
        repo,
        number,
    })
}

fn notification_summary(item: &Value) -> Value {
    json!({
        "id": item.get("id").cloned().unwrap_or(Value::Null),
        "reason": item.get("reason").cloned().unwrap_or(Value::Null),
        "unread": item.get("unread").cloned().unwrap_or(Value::Null),
        "updatedAt": item.get("updated_at").cloned().unwrap_or(Value::Null),
        "title": text_at(item, "/subject/title", 300),
        "type": item.pointer("/subject/type").cloned().unwrap_or(Value::Null),
        "repository": item.pointer("/repository/full_name").cloned().unwrap_or(Value::Null),
    })
}

fn checks_summary(checks: &Value) -> Value {
    let (mut success, mut failing, mut pending, mut other) = (0, Vec::new(), 0, 0);
    for run in list_at(checks, "/check_runs") {
        let name = text_at(run, "/name", 120).unwrap_or_default();
        match (
            run.get("status").and_then(Value::as_str),
            run.get("conclusion").and_then(Value::as_str),
        ) {
            (Some("completed"), Some("success")) => success += 1,
            (
                Some("completed"),
                Some("failure" | "timed_out" | "cancelled" | "action_required"),
            ) => failing.push(name),
            (Some("completed"), _) => other += 1,
            _ => pending += 1,
        }
    }
    failing.truncate(10);
    json!({
        "total": checks.get("total_count").cloned().unwrap_or(Value::Null),
        "success": success,
        "failing": failing,
        "pending": pending,
        "other": other,
    })
}

impl GithubAdapter {
    async fn notifications(&self, args: &Value, token: &str) -> Result<Value, ProviderError> {
        let flag = |key: &str| args.get(key).and_then(Value::as_bool).unwrap_or(false);
        let query = [
            ("per_page", "50".to_string()),
            ("all", flag("all").to_string()),
            ("participating", flag("participating").to_string()),
        ];
        let body = self.api.get("/notifications", token, &query).await?;
        let items = list_at(&body, "")
            .map(notification_summary)
            .collect::<Vec<_>>();
        Ok(json!({ "notifications": items }))
    }

    async fn pull_request(&self, args: &Value, token: &str) -> Result<Value, ProviderError> {
        let target = repo_ref(args)?;
        let base = format!(
            "/repos/{}/{}/pulls/{}",
            target.owner, target.repo, target.number
        );
        let pull = self.api.get(&base, token, &[]).await?;
        let reviews = self
            .api
            .get(
                &format!("{base}/reviews"),
                token,
                &[("per_page", "50".into())],
            )
            .await?;
        let reviews = list_at(&reviews, "")
            .map(|review| {
                json!({
                    "author": review.pointer("/user/login").cloned().unwrap_or(Value::Null),
                    "state": review.get("state").cloned().unwrap_or(Value::Null),
                    "submittedAt": review.get("submitted_at").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();
        let sha = pull
            .pointer("/head/sha")
            .and_then(Value::as_str)
            .filter(|sha| sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit()));
        let checks = match sha {
            Some(sha) => {
                let path = format!(
                    "/repos/{}/{}/commits/{sha}/check-runs",
                    target.owner, target.repo
                );
                let runs = self
                    .api
                    .get(&path, token, &[("per_page", "50".into())])
                    .await?;
                checks_summary(&runs)
            }
            None => Value::Null,
        };
        Ok(json!({
            "number": target.number,
            "title": text_at(&pull, "/title", 300),
            "state": pull.get("state").cloned().unwrap_or(Value::Null),
            "merged": pull.get("merged").cloned().unwrap_or(Value::Null),
            "draft": pull.get("draft").cloned().unwrap_or(Value::Null),
            "author": pull.pointer("/user/login").cloned().unwrap_or(Value::Null),
            "mergeableState": pull.get("mergeable_state").cloned().unwrap_or(Value::Null),
            "url": pull.get("html_url").cloned().unwrap_or(Value::Null),
            "body": text_at(&pull, "/body", MAX_TEXT_CHARS),
            "reviews": reviews,
            "checks": checks,
        }))
    }

    async fn comment(&self, args: &Value, token: &str) -> Result<Value, ProviderError> {
        let target = repo_ref(args)?;
        let body = required_str(args, "body", MAX_COMMENT_CHARS)?;
        let path = format!(
            "/repos/{}/{}/issues/{}/comments",
            target.owner, target.repo, target.number
        );
        let created = self
            .api
            .post(&path, token, &json!({ "body": body }))
            .await?;
        Ok(json!({
            "id": created.get("id").cloned().unwrap_or(Value::Null),
            "url": created.get("html_url").cloned().unwrap_or(Value::Null),
            "body": cap_text(body, 200),
        }))
    }
}

#[async_trait]
impl ServiceAdapter for GithubAdapter {
    fn tools(&self) -> &'static [ConnectorToolDescriptor] {
        &TOOLS
    }

    async fn execute(
        &self,
        tool: &str,
        args: &Value,
        secret: &ConnectorSecret,
        _settings: &Value,
    ) -> Result<Value, ProviderError> {
        let token = secret.access_token.as_str();
        match tool {
            NOTIFICATIONS => self.notifications(args, token).await,
            PULL_REQUEST => self.pull_request(args, token).await,
            COMMENT => self.comment(args, token).await,
            _ => Err(ProviderError::UnknownTool),
        }
    }

    async fn account_identity(
        &self,
        secret: &ConnectorSecret,
    ) -> Result<Option<String>, ProviderError> {
        let user = self.api.get("/user", &secret.access_token, &[]).await?;
        Ok(user
            .get("id")
            .and_then(Value::as_u64)
            .map(|id| id.to_string()))
    }

    fn live_subscription(&self, hooks: &ConnectorHooks) -> bool {
        // The webhook is registered on the GitHub App or organization, not
        // per connector, so there is nothing to subscribe here.
        hooks.github_webhook_secret.is_some()
    }

    async fn poll(
        &self,
        secret: &ConnectorSecret,
        since: DateTime<Utc>,
        _settings: &Value,
    ) -> Result<Vec<PolledEvent>, ProviderError> {
        let query = [
            ("per_page", "50".to_string()),
            ("since", since.to_rfc3339()),
        ];
        let body = self
            .api
            .get("/notifications", &secret.access_token, &query)
            .await?;
        Ok(list_at(&body, "")
            .filter_map(|item| {
                let id = item.get("id").and_then(Value::as_str)?;
                let updated = item.get("updated_at").and_then(Value::as_str)?;
                let occurred_at = DateTime::parse_from_rfc3339(updated).ok()?;
                Some(PolledEvent {
                    kind: "notification".into(),
                    external_id: format!("notification:{id}:{updated}"),
                    occurred_at: occurred_at.with_timezone(&Utc),
                    payload: notification_summary(item),
                })
            })
            .collect())
    }
}
