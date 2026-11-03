//! Owner-local discovery uses the authorized sync catalog, not hydrated transcripts.
use super::*;
use kordi_tools::{SearchSessionsRequest, SessionObservationSearchResult};

pub(in crate::chat::session_observation) struct OwnerCatalog {
    base: String,
    owner: String,
    token: Arc<dyn Fn() -> KordiResult<String> + Send + Sync>,
    client: reqwest::Client,
}

fn owner_identity(
    identity: Option<&kordi_cli::desktop_runtime::DesktopChatContextMessage>,
    account: &str,
) -> bool {
    !account.trim().is_empty()
        && identity.is_none_or(|message| {
            serde_json::from_str::<kordi_core::types::RuntimeIdentity>(&message.text).is_ok_and(
                |id| id.owner_account_id == account && id.requester_account_id == account,
            )
        })
}

pub(in crate::chat::session_observation) fn owner_catalog(
    identity: Option<&kordi_cli::desktop_runtime::DesktopChatContextMessage>,
) -> KordiResult<Option<OwnerCatalog>> {
    let Some(session) = crate::cloud_session::cloud_session_load().map_err(|_| unavailable())?
    else {
        return Ok(None);
    };
    if !owner_identity(identity, &session.account_id) || session.token.is_empty() {
        return Err(unavailable());
    }
    let owner = session.account_id;
    let expected = owner.clone();
    Ok(Some(OwnerCatalog {
        base: crate::cloud_api_base_url_from_env().map_err(|_| unavailable())?,
        owner,
        token: Arc::new(move || {
            let current = crate::cloud_session::cloud_session_load()
                .ok()
                .flatten()
                .ok_or_else(unavailable)?;
            if current.account_id != expected || current.token.is_empty() {
                return Err(unavailable());
            }
            Ok(current.token)
        }),
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| unavailable())?,
    }))
}

impl OwnerCatalog {
    async fn token(&self) -> KordiResult<String> {
        let source = self.token.clone();
        tokio::task::spawn_blocking(move || source())
            .await
            .map_err(|_| unavailable())?
    }

    pub(in crate::chat::session_observation) async fn conversations(
        &self,
    ) -> KordiResult<Vec<Value>> {
        let mut response = self
            .client
            .get(format!(
                "{}/v2/chat/sync/bootstrap",
                self.base.trim_end_matches('/')
            ))
            .bearer_auth(self.token().await?)
            .send()
            .await
            .map_err(|_| unavailable())?;
        const MAX_BYTES: usize = 8 * 1024 * 1024;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|size| size > MAX_BYTES as u64)
        {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > MAX_BYTES {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        self.token().await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        let conversations = value["conversations"].as_array().ok_or_else(unavailable)?;
        let deleted = value["session_visibility"]["deletedSessionIds"].as_array();
        Ok(conversations
            .iter()
            .filter(|c| {
                if deleted.is_some_and(|ids| {
                    ids.iter()
                        .any(|id| id == &c["legacy_session_id"] || id == &c["id"])
                }) {
                    return false;
                }
                c["members"].as_array().is_some_and(|members| {
                    members
                        .iter()
                        .any(|m| m["account_id"] == self.owner && m["membership_state"] == "active")
                })
            })
            .cloned()
            .collect())
    }

    pub(in crate::chat::session_observation) async fn read(
        &self,
        mut request: ReadSessionRequest,
    ) -> KordiResult<Option<kordi_tools::ReadSessionResponse>> {
        request.session_id = request.session_id.trim().to_owned();
        if !contains(&self.conversations().await?, &request.session_id) {
            return Ok(None);
        }
        // The session was just discovered in a fresh catalog. The
        // member endpoint independently rechecks membership and media visibility.
        let scope = request.session_id.clone();
        let observation = Arc::new(CloudObservation {
            authorization: json!({"sessionId":scope}),
            scope,
            endpoint: format!(
                "{}/v1/cloud/agent-runs/desktop/read-context",
                self.base.trim_end_matches('/')
            ),
            client: self.client.clone(),
            token: self.token.clone(),
        });
        (runtime(observation, None).read_session)(request)
            .await
            .map(Some)
    }
}

pub(in crate::chat::session_observation) fn contains(
    conversations: &[Value],
    session: &str,
) -> bool {
    conversations
        .iter()
        .any(|c| c["legacy_session_id"].as_str() == Some(session))
}

fn normalized(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

pub(in crate::chat::session_observation) fn search(
    conversations: &[Value],
    request: &SearchSessionsRequest,
) -> Vec<SessionObservationSearchResult> {
    let query = normalized(&request.query);
    if query.is_empty() {
        return Vec::new();
    }
    let mut matches = Vec::new();
    for c in conversations {
        let Some(id) = c["legacy_session_id"].as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let names = [
            c["group_title"].as_str(),
            c["shared_title"].as_str(),
            c["preferences"]["personal_title"].as_str(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>();
        let participants = c["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["membership_state"] == "active")
            .filter_map(|m| m["display_name"].as_str())
            .collect::<Vec<_>>();
        if !normalized(&names.join(" ")).contains(&query)
            && !participants
                .iter()
                .any(|name| normalized(name).contains(&query))
        {
            continue;
        }
        matches.push(SessionObservationSearchResult {
            session_id: id.into(),
            title: if names.is_empty() { "Conversation".into() } else { names.join(" / ") },
            kind: c["kind"].as_str().unwrap_or("group").into(),
            participants: participants.into_iter().map(str::to_owned).collect(),
            updated_at_label: c["updated_at"].as_str().map(str::to_string),
            reason: "Matched authorized conversation title or participant; use read_session for current messages".into(),
            snippets: Vec::new(),
        });
    }
    matches.sort_by(|a, b| {
        b.updated_at_label
            .cmp(&a.updated_at_label)
            .then(a.session_id.cmp(&b.session_id))
    });
    matches.truncate(request.limit.unwrap_or(8).clamp(1, 20));
    matches
}

#[cfg(test)]
mod tests;
