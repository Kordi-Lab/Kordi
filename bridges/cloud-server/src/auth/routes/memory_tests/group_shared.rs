//! Group memories are shared by the group's active members.

use super::*;

pub(super) struct Group {
    pub(super) a: Fixture,
    pub(super) b: Fixture,
    pub(super) c: Fixture,
    pub(super) group_id: String,
    a_name: String,
}

/// Three accounts: A and B are active members of a new group, C is not.
pub(super) async fn group() -> Option<Group> {
    let a = fixture().await?;
    let b = fixture().await?;
    let c = fixture().await?;
    let a_name = format!("Member {}", &a.account_id[12..20]);
    query("UPDATE cloud_accounts SET display_name = $2 WHERE account_id = $1")
        .bind(&a.account_id)
        .bind(&a_name)
        .execute(&a.pool)
        .await
        .unwrap();
    let group_id = uuid::Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations(conversation_id, kind, created_by_account_id, \
         client_operation_id, creation_fingerprint, legacy_session_id) \
         VALUES ($1, 'group', $2, $3, 'memory-group-shared', $4)",
    )
    .bind(group_id)
    .bind(&a.account_id)
    .bind(uuid::Uuid::new_v4())
    .bind(format!("session:group:{group_id}"))
    .execute(&a.pool)
    .await
    .unwrap();
    for member in [&a.account_id, &b.account_id] {
        query(
            "INSERT INTO cloud_chat_conversation_members(conversation_id, account_id) \
             VALUES ($1, $2)",
        )
        .bind(group_id)
        .bind(member)
        .execute(&a.pool)
        .await
        .unwrap();
    }
    Some(Group {
        a,
        b,
        c,
        group_id: group_id.to_string(),
        a_name,
    })
}

impl Group {
    pub(super) fn body(&self, text: &str) -> Value {
        json!({
            "scope": "group",
            "scopeId": self.group_id,
            "scopeLabel": "Design crew",
            "source": "manual",
            "text": text,
        })
    }

    /// The group's session id, as cloud runs in the group carry it.
    pub(super) fn session_id(&self) -> String {
        format!("session:group:{}", self.group_id)
    }

    /// Removes the group, its runs, and the three fixture accounts with their
    /// memories, sessions, and audit rows.
    pub(super) async fn cleanup(self) {
        let pool = &self.a.pool;
        let accounts = [&self.a.account_id, &self.b.account_id, &self.c.account_id];
        query("DELETE FROM cloud_chat_conversations WHERE conversation_id = $1::uuid")
            .bind(&self.group_id)
            .execute(pool)
            .await
            .unwrap();
        for account in accounts {
            for sql in [
                "DELETE FROM cloud_agent_fallback_runs WHERE owner_account_id = $1",
                "DELETE FROM cloud_audit_events WHERE account_id = $1",
                "DELETE FROM cloud_accounts WHERE account_id = $1",
            ] {
                query(sql).bind(account).execute(pool).await.unwrap();
            }
        }
    }
}

pub(super) fn ids(list: &Value) -> Vec<String> {
    list["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|memory| memory["memoryId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn group_memories_are_shared_by_active_members() {
    let Some(g) = group().await else { return };

    // A saves a group memory and a private conversation memory.
    let (status, saved) =
        g.a.send(
            "POST",
            "/v1/cloud/memory",
            Some(g.body("Demo on Thursdays")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let memory = saved["memory"].clone();
    let memory_id = memory["memoryId"].as_str().unwrap().to_string();
    assert_eq!(memory["ownerAccountId"], g.a.account_id.as_str());
    assert_eq!(memory["ownerName"], g.a_name.as_str());
    let (_, private) =
        g.a.send("POST", "/v1/cloud/memory", Some(memory_body("A only")))
            .await;
    let private_id = private["memory"]["memoryId"].as_str().unwrap().to_string();

    // B lists A's group memory, but not A's private one.
    let (status, list) = g.b.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&list), vec![memory_id.clone()]);
    assert_eq!(list["memories"][0], memory);

    // C is not a member: nothing listed, and no save, edit, or delete.
    let (_, list) = g.c.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"], json!([]));
    let (status, error) =
        g.c.send("POST", "/v1/cloud/memory", Some(g.body("Sneaky")))
            .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::FORBIDDEN, json!("not_a_group_member"))
    );
    let (status, error) =
        g.c.send(
            "PATCH",
            &format!("/v1/cloud/memory/{memory_id}"),
            Some(json!({ "text": "Changed" })),
        )
        .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::FORBIDDEN, json!("not_a_group_member"))
    );
    let (status, _) =
        g.c.send("DELETE", &format!("/v1/cloud/memory/{memory_id}"), None)
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Other members still cannot touch a private memory.
    let (status, _) =
        g.b.send("DELETE", &format!("/v1/cloud/memory/{private_id}"), None)
            .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A group id that is not a uuid is never a group.
    let mut not_a_group = g.body("Anything");
    not_a_group["scopeId"] = json!("not-a-uuid");
    let (status, _) =
        g.a.send("POST", "/v1/cloud/memory", Some(not_a_group))
            .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // B saving the same text gets A's memory back, with no second row.
    let (status, again) =
        g.b.send(
            "POST",
            "/v1/cloud/memory",
            Some(g.body("Demo  on Thursdays")),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["memory"]["memoryId"], memory_id.as_str());
    assert_eq!(again["memory"]["ownerAccountId"], g.a.account_id.as_str());
    let (rows,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_account_memories WHERE scope_id = $1")
            .bind(&g.group_id)
            .fetch_one(&g.a.pool)
            .await
            .unwrap();
    assert_eq!(rows, 1);

    // B edits A's group memory; the owner stays A.
    let (status, edited) =
        g.b.send(
            "PATCH",
            &format!("/v1/cloud/memory/{memory_id}"),
            Some(json!({ "text": "Demo on Fridays" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["text"], "Demo on Fridays");
    assert_eq!(edited["memory"]["ownerAccountId"], g.a.account_id.as_str());
    let (_, list) = g.a.send("GET", "/v1/cloud/memory", None).await;
    assert!(list["memories"]
        .as_array()
        .unwrap()
        .iter()
        .any(|memory| memory["text"] == "Demo on Fridays"));

    // B deletes A's group memory.
    let (status, _) =
        g.b.send("DELETE", &format!("/v1/cloud/memory/{memory_id}"), None)
            .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, list) = g.a.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(ids(&list), vec![private_id]);

    g.cleanup().await;
}

#[tokio::test]
async fn forget_everything_keeps_other_members_group_memories() {
    let Some(g) = group().await else { return };
    let (_, from_a) =
        g.a.send("POST", "/v1/cloud/memory", Some(g.body("A's group note")))
            .await;
    let (_, from_b) =
        g.b.send("POST", "/v1/cloud/memory", Some(g.body("B's group note")))
            .await;
    let b_id = from_b["memory"]["memoryId"].as_str().unwrap().to_string();
    assert_eq!(from_b["memory"]["ownerAccountId"], g.b.account_id.as_str());

    let (status, forgotten) = g.a.send("DELETE", "/v1/cloud/memory", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(forgotten["archived"], 1);
    let (_, list) = g.a.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(ids(&list), vec![b_id.clone()]);
    let (_, list) = g.b.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(ids(&list), vec![b_id]);
    assert_ne!(from_a["memory"]["memoryId"], Value::Null);

    g.cleanup().await;
}

#[tokio::test]
async fn runner_list_includes_group_memories_of_other_members() {
    let Some(g) = group().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", RUNNER_TOKEN);
    let runner_auth = format!("Bearer {RUNNER_TOKEN}");
    let runner_id = format!("runner_{}", uuid::Uuid::new_v4().simple());
    let run_id =
        g.b.leased_run_in(&runner_id, &g.session_id(), &g.b.account_id)
            .await;
    let (_, saved) =
        g.a.send(
            "POST",
            "/v1/cloud/memory",
            Some(g.body("Use the shared bucket")),
        )
        .await;
    let memory_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();

    let (status, list) =
        g.b.send_with_auth(
            "GET",
            &format!("/v1/cloud/agent-runs/{run_id}/memory?runnerId={runner_id}"),
            None,
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&list), vec![memory_id]);
    assert_eq!(list["memories"][0]["ownerName"], g.a_name.as_str());

    // The runner saves as B, and only into the run's own group.
    let mut save = g.body("Tag releases on main");
    save["runnerId"] = json!(runner_id);
    let (status, saved) =
        g.b.send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(save.clone()),
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(saved["memory"]["ownerAccountId"], g.b.account_id.as_str());
    save["scopeId"] = json!(uuid::Uuid::new_v4().to_string());
    let (status, error) =
        g.b.send_with_auth(
            "POST",
            &format!("/v1/cloud/agent-runs/{run_id}/memory"),
            Some(save),
            &runner_auth,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["errorCode"], "memory_scope_not_allowed");

    g.cleanup().await;
}
