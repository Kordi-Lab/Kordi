use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};

#[path = "desktop_fallback.rs"]
mod fallback;
#[path = "desktop_proof_refusals.rs"]
mod refusals;

const HOSTED_ROUTE: &str = "cloud-api-key:work";
/// The audience a desktop names for a server whose public base URL is not
/// configured, as in these tests.
const AUDIENCE: &str = "https://kordi.ai";

struct Desktop {
    account: TestAccount,
    email: String,
    key: SigningKey,
    device_id: String,
}

/// Publishes readiness. A desktop that signs device proofs names the
/// signed-text version it uses.
async fn ready(router: &axum::Router, account: &TestAccount, device_proof: Option<bool>) {
    let fields = match device_proof {
        Some(true) => json!({"deviceProof":true,"deviceProofVersion":2}),
        Some(false) => json!({"deviceProof":false}),
        None => json!({}),
    };
    publish_ready(router, account, fields).await;
}

async fn publish_ready(router: &axum::Router, account: &TestAccount, fields: Value) {
    let online = router
        .clone()
        .oneshot(post_with_token("/v1/cloud/presence/online", &account.token))
        .await
        .unwrap();
    assert_eq!(online.status(), StatusCode::OK);
    let mut body = json!({"agentIds":[format!("cloud-agent:{}", account.account_id)]});
    for (name, value) in fields.as_object().unwrap() {
        body[name] = value.clone();
    }
    let ready = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/ready",
            &account.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
}

async fn save_hosted_account(router: &axum::Router, account: &TestAccount) {
    let saved = router.clone().oneshot(post_json_with_token(
        "/v1/cloud/agent-provider-auth/snapshots?intent=explicit", &account.token,
        json!({"provider":"openai","authChoice":HOSTED_ROUTE,
            "payload":{"apiKey":"synthetic-desktop-key","baseUrl":"https://api.openai.com/v1","model":"gpt-4.1-mini"}}),
    )).await.unwrap();
    assert_eq!(saved.status(), StatusCode::CREATED);
}

/// A request in the owner's own agent conversation on `auth_choice`.
async fn request(
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    auth_choice: &str,
) -> (Value, uuid::Uuid) {
    let session = format!("session:self-agent:{}", uuid::Uuid::new_v4());
    let conversation = create_test_conversation(
        pool,
        &owner.account_id,
        &session,
        ConversationKind::Ai,
        vec![],
    )
    .await;
    let message = insert_test_message(pool, &owner.account_id, conversation, "Synthetic").await;
    let claim_id = uuid::Uuid::new_v4();
    let body = json!({"requestMessageId":message,"sessionId":session,
        "ownerAccountId":owner.account_id,"requesterAccountId":owner.account_id,
        "prompt":"Synthetic request","idempotencyKey":format!("desktop-provider:{claim_id}"),
        "runtimeRoute":{"defaultModel":"openai/gpt-4.1-mini",
            "defaultAuthProvider":"openai","defaultAuthChoice":auth_choice}});
    (body, claim_id)
}

async fn desktop_claim(
    router: &axum::Router,
    owner: &TestAccount,
    body: &Value,
    claim_id: uuid::Uuid,
) -> Value {
    let mut body = body.clone();
    body["claimId"] = json!(claim_id);
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/desktop/claim",
            &owner.token,
            body,
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    read_json(claim).await
}

async fn claimed_run(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
) -> (String, uuid::Uuid) {
    let (body, claim_id) = request(pool, owner, HOSTED_ROUTE).await;
    let claim = desktop_claim(router, owner, &body, claim_id).await;
    assert_eq!(claim["acquired"], true);
    (claim["runId"].as_str().unwrap().to_string(), claim_id)
}

async fn challenge(
    router: &axum::Router,
    account: &TestAccount,
    run: &str,
    claim: uuid::Uuid,
) -> axum::response::Response {
    router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/{run}/desktop/provider-auth/challenge"),
            &account.token,
            json!({"claimId":claim}),
        ))
        .await
        .unwrap()
}

async fn nonce(
    router: &axum::Router,
    account: &TestAccount,
    run: &str,
    claim: uuid::Uuid,
) -> String {
    let response = challenge(router, account, run, claim).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = read_json(response).await;
    assert_eq!(body["algorithm"], "ecdsa-p256-sha256");
    assert_eq!(body["purpose"], "desktop-provider-auth");
    assert_eq!(body["version"], 2);
    assert!(body["deviceId"].as_str().unwrap().starts_with("dev_"));
    body["nonce"].as_str().unwrap().to_string()
}

/// The signed text is a protocol contract with the desktop.
fn message(
    audience: &str,
    account: &str,
    device: &str,
    run: &str,
    claim: uuid::Uuid,
    nonce: &str,
) -> String {
    format!(
        "kordi-device-proof-v2\npurpose:desktop-provider-auth\naudience:{audience}\naccount:{account}\n\
         device:{device}\nrun:{run}\nclaim:{claim}\nnonce:{nonce}"
    )
}

/// A proof that names `audience` and signs `message` with `key`.
fn signed(key: &SigningKey, audience: &str, message: &str, nonce: &str) -> Value {
    let signature: Signature = key.sign(message.as_bytes());
    json!({"version":2,"audience":audience,"nonce":nonce,
        "signature":URL_SAFE_NO_PAD.encode(signature.to_bytes())})
}

fn proof(
    key: &SigningKey,
    account: &str,
    device: &str,
    run: &str,
    claim: uuid::Uuid,
    nonce: &str,
) -> Value {
    signed(
        key,
        AUDIENCE,
        &message(AUDIENCE, account, device, run, claim, nonce),
        nonce,
    )
}

async fn provider_auth(
    router: &axum::Router,
    account: &TestAccount,
    run: &str,
    claim: uuid::Uuid,
    proof: Option<Value>,
) -> (StatusCode, Value) {
    let mut body = json!({"claimId":claim});
    if let Some(proof) = proof {
        body["deviceProof"] = proof;
    }
    let response = router
        .clone()
        .oneshot(post_json_with_token(
            &format!("/v1/cloud/agent-runs/{run}/desktop/provider-auth"),
            &account.token,
            body,
        ))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn setup() -> Option<(sqlx_postgres::PgPool, axum::Router, Desktop)> {
    let pool = try_pool().await?;
    std::env::set_var(
        "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
        "test-provider-auth-key-that-is-long-enough",
    );
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let key = random_device_key();
    let email = unique_email("desktop-proof");
    let account = sign_in_with_device_key(&router, "/v1/cloud/auth/signup", &email, &key).await;
    let device_id = device_id_for_key(&pool, &account, &key).await;
    ready(&router, &account, Some(true)).await;
    save_hosted_account(&router, &account).await;
    Some((
        pool,
        router,
        Desktop {
            account,
            email,
            key,
            device_id,
        },
    ))
}

#[tokio::test]
async fn desktop_provider_auth_requires_the_live_owner_mac_claim_and_device_proof() {
    let Some((pool, router, mac)) = setup().await else {
        return;
    };
    let other = signup(&router, "desktop-provider-other", "Other").await;
    let (run, claim) = claimed_run(&router, &pool, &mac.account).await;
    let owner = &mac.account.account_id;

    let (status, _) = provider_auth(&router, &mac.account, &run, uuid::Uuid::new_v4(), None).await;
    assert_eq!(status, StatusCode::CONFLICT, "another claim holds no lease");
    let (status, _) = provider_auth(&router, &other, &run, claim, None).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "another account holds no lease"
    );
    let response = challenge(&router, &mac.account, &run, uuid::Uuid::new_v4()).await;
    assert_eq!(
        response.status(),
        StatusCode::CONFLICT,
        "no challenge without the lease"
    );

    let (status, body) = provider_auth(&router, &mac.account, &run, claim, None).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a session token alone is refused"
    );
    assert_eq!(body["errorCode"], "device_proof_required");

    // A desktop that signs the earlier text, which names neither the server
    // nor the device, is asked to update.
    let issued = nonce(&router, &mac.account, &run, claim).await;
    let earlier = format!(
        "kordi-device-proof-v1\npurpose:desktop-provider-auth\naccount:{owner}\nrun:{run}\nclaim:{claim}\nnonce:{issued}"
    );
    let mut earlier = signed(&mac.key, AUDIENCE, &earlier, &issued);
    earlier.as_object_mut().unwrap().remove("version");
    earlier.as_object_mut().unwrap().remove("audience");
    let (status, body) = provider_auth(&router, &mac.account, &run, claim, Some(earlier)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["errorCode"], "device_proof_required");

    let issued = nonce(&router, &mac.account, &run, claim).await;
    let (status, body) = provider_auth(
        &router,
        &mac.account,
        &run,
        claim,
        Some(proof(&mac.key, owner, &mac.device_id, &run, claim, &issued)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["providerAuth"]["authChoice"], HOSTED_ROUTE);
    assert_eq!(
        body["providerAuth"]["payload"]["apiKey"],
        "synthetic-desktop-key"
    );
    assert!(body["providerAuth"]["payload"]
        .get("refreshToken")
        .is_none());

    let (status, body) = provider_auth(
        &router,
        &mac.account,
        &run,
        claim,
        Some(proof(&mac.key, owner, &mac.device_id, &run, claim, &issued)),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a used challenge cannot be replayed"
    );
    assert_eq!(body["errorCode"], "device_proof_invalid");

    sqlx_core::query::query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(&run).execute(&pool).await.unwrap();
    let (status, _) = provider_auth(&router, &mac.account, &run, claim, None).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "an expired lease is refused first"
    );
}
