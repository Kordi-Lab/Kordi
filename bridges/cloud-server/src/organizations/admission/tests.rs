//! Database tests for organization admission, through the sign-in hook and
//! the public routes. They use the Common ground fixture and its skip rule.
//! Each test configures its own organization id, so tests share a database.

use std::sync::{Arc, Mutex};

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::config::{OrganizationAdmission, SignInMethod};
use super::hooks::record_sign_in;
use super::test_support::{parse, sample_file};
use super::SignInEvidence;
use crate::common_ground::tests::db_fixture::{pool, send, signed_in};
use crate::events::EventBus;
use crate::server::ServerState;

mod admins;
mod guards;
mod join_requests;
mod reverify;
mod web_session;

const ACCOUNT_ORGS: &str = "/v1/cloud/account/organizations";

pub(super) struct CapturingSender(pub(super) Mutex<Option<(String, String)>>);

#[async_trait::async_trait]
impl crate::auth::signup_email::SignupCodeSender for CapturingSender {
    async fn send_code(&self, email: &str, code: &str) -> Result<(), &'static str> {
        *self.0.lock().unwrap() = Some((email.to_string(), code.to_string()));
        Ok(())
    }
}

pub(super) struct Harness {
    pub(super) pool: PgPool,
    pub(super) app: axum::Router,
    pub(super) admission: OrganizationAdmission,
    pub(super) sender: Arc<CapturingSender>,
}

impl Harness {
    pub(super) fn config_id(&self) -> &str {
        &self.admission.organizations[0].id
    }

    pub(super) fn organization_id(&self) -> &str {
        &self.admission.organizations[0].organization_id
    }

    /// The caller's entry for this test's organization.
    pub(super) async fn entry(&self, token: &str) -> Value {
        let (status, body) = send(&self.app, "GET", ACCOUNT_ORGS, token, None).await;
        assert_eq!(status, 200, "{body}");
        body["configured"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == self.config_id())
            .cloned()
            .unwrap()
    }

    pub(super) async fn sign_in(
        &self,
        account: &str,
        method: SignInMethod,
        email: &str,
        verified: bool,
        hd: Option<&str>,
    ) {
        let evidence = SignInEvidence {
            method,
            email: Some(email),
            email_verified: verified,
            hosted_domain: hd,
        };
        record_sign_in(&self.pool, &self.admission, account, evidence).await;
    }

    pub(super) async fn role(&self, account: &str) -> Option<String> {
        let row: Option<(String,)> = query_as(
            "SELECT role FROM cloud_organization_members WHERE organization_id = $1 AND account_id = $2",
        )
        .bind(self.organization_id())
        .bind(account)
        .fetch_optional(&self.pool)
        .await
        .unwrap();
        row.map(|(role,)| role)
    }
}

/// A synced admission file with one organization edited by `edit` and the
/// given admin account ids.
pub(super) async fn harness(edit: impl FnOnce(&mut Value), admins: &[&str]) -> Option<Harness> {
    let pool = pool().await?;
    Some(harness_on(pool, edit, admins).await)
}

pub(super) async fn harness_on(
    pool: PgPool,
    edit: impl FnOnce(&mut Value),
    admins: &[&str],
) -> Harness {
    let id = format!("t-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let mut file = sample_file(&id);
    edit(&mut file["organizations"][0]);
    let admission = parse(&file, &serde_json::to_string(admins).unwrap())
        .unwrap()
        .sync_configured(&pool)
        .await
        .unwrap();
    let sender = Arc::new(CapturingSender(Mutex::new(None)));
    let service =
        crate::auth::signup_email::SignupEmailService::new(sender.clone(), vec![7; 32]).unwrap();
    let state = ServerState::new(pool.clone(), EventBus::noop())
        .with_organization_admission(admission.clone())
        .with_signup_email(service);
    let app = crate::server::router(Arc::new(state));
    Harness {
        pool,
        app,
        admission,
        sender,
    }
}

#[tokio::test]
async fn sync_is_idempotent_and_keeps_configured_admins_in_step() {
    let Some(pool) = pool().await else { return };
    let (admin, _) = signed_in(&pool, "adm_sync").await;
    let id = format!("t-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let admins = serde_json::to_string(&[&admin]).unwrap();
    let first = parse(&sample_file(&id), &admins)
        .unwrap()
        .sync_configured(&pool)
        .await
        .unwrap();
    let mut renamed = sample_file(&id);
    renamed["organizations"][0]["displayName"] = "Example Research Group".into();
    let second = parse(&renamed, &admins)
        .unwrap()
        .sync_configured(&pool)
        .await
        .unwrap();
    let organization_id = &first.organizations[0].organization_id;
    assert!(organization_id.starts_with("org_"));
    assert_eq!(organization_id, &second.organizations[0].organization_id);
    let (name, kind, role, flagged): (String, String, String, bool) = query_as(
        "SELECT o.name, o.kind, m.role, m.configured_admin FROM cloud_organizations o \
         JOIN cloud_organization_members m ON m.organization_id = o.organization_id \
         WHERE o.config_id = $1 AND m.account_id = $2",
    )
    .bind(&id)
    .bind(&admin)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (name.as_str(), kind.as_str(), role.as_str(), flagged),
        ("Example Research Group", "team", "admin", true)
    );

    // Dropped from the variable and never admitted otherwise: removed.
    parse(&renamed, "[]")
        .unwrap()
        .sync_configured(&pool)
        .await
        .unwrap();
    let left: Option<(String,)> = query_as(
        "SELECT role FROM cloud_organization_members WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(organization_id)
    .bind(&admin)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(left, None);
}

#[tokio::test]
async fn google_sign_in_joins_only_with_the_hosted_domain() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (with_hd, token) = signed_in(&h.pool, "adm_hd").await;
    let (without_hd, _) = signed_in(&h.pool, "adm_nohd").await;
    h.sign_in(
        &with_hd,
        SignInMethod::Google,
        &format!("{with_hd}@example.test"),
        true,
        Some("example.test"),
    )
    .await;
    h.sign_in(
        &without_hd,
        SignInMethod::Google,
        &format!("{without_hd}@example.test"),
        true,
        None,
    )
    .await;
    assert_eq!(h.role(&with_hd).await.as_deref(), Some("member"));
    assert_eq!(h.role(&without_hd).await, None);
    let entry = h.entry(&token).await;
    assert_eq!(entry["admission"], "member", "{entry}");
    assert!(entry["reverifyBy"].is_string(), "{entry}");
    assert_eq!(entry["entryPage"]["joinLabel"], "Join Example Research");
}

#[tokio::test]
async fn github_and_unverified_emails_do_not_join() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (github, token) = signed_in(&h.pool, "adm_gh").await;
    let (unverified, _) = signed_in(&h.pool, "adm_unv").await;
    h.sign_in(
        &github,
        SignInMethod::Github,
        &format!("{github}@example.test"),
        true,
        None,
    )
    .await;
    h.sign_in(
        &unverified,
        SignInMethod::Google,
        &format!("{unverified}@example.test"),
        false,
        Some("example.test"),
    )
    .await;
    h.sign_in(
        &unverified,
        SignInMethod::EmailCode,
        &format!("{unverified}@example.test"),
        false,
        None,
    )
    .await;
    assert_eq!(h.role(&github).await, None);
    assert_eq!(h.role(&unverified).await, None);
    let entry = h.entry(&token).await;
    assert_eq!(entry["admission"], "join", "{entry}");
    assert_eq!(entry["joinOptions"]["emailCode"], true);
}

#[tokio::test]
async fn a_disabled_organization_does_nothing() {
    let Some(h) = harness(|o| o["state"] = "disabled".into(), &[]).await else {
        return;
    };
    let (account, token) = signed_in(&h.pool, "adm_off").await;
    let email = format!("{account}@example.test");
    h.sign_in(
        &account,
        SignInMethod::Google,
        &email,
        true,
        Some("example.test"),
    )
    .await;
    h.sign_in(&account, SignInMethod::EmailCode, &email, true, None)
        .await;
    assert_eq!(h.role(&account).await, None);
    let entry = h.entry(&token).await;
    assert_eq!(entry["admission"], "not_open", "{entry}");
    assert_eq!(
        entry["entryPage"]["notOpenText"],
        "Example Research is not open yet."
    );

    let base = format!("{ACCOUNT_ORGS}/{}", h.config_id());
    let request = serde_json::json!({"fields": {"affiliation": "Example Lab"}});
    let (status, body) = send(
        &h.app,
        "POST",
        &format!("{base}/join-requests"),
        &token,
        Some(request),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("join_requests_closed"))
    );
    let code = serde_json::json!({"email": email});
    let (status, body) = send(
        &h.app,
        "POST",
        &format!("{base}/email-code"),
        &token,
        Some(code),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("organization_not_open"))
    );
    assert!(h.sender.0.lock().unwrap().is_none());
}

#[tokio::test]
async fn an_organization_email_code_joins_once_per_email() {
    let Some(h) = harness(|_| {}, &[]).await else {
        return;
    };
    let (alex, alex_token) = signed_in(&h.pool, "adm_code_a").await;
    let (sam, sam_token) = signed_in(&h.pool, "adm_code_b").await;
    let base = format!("{ACCOUNT_ORGS}/{}/email-code", h.config_id());
    let off_domain = serde_json::json!({"email": "alex@other.test"});
    let (status, body) = send(&h.app, "POST", &base, &alex_token, Some(off_domain)).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (403, Some("email_not_claimed"))
    );

    let work_email = format!("lab-{alex}@example.test");
    let verify = format!("{base}/verify");
    let request = serde_json::json!({"email": work_email.to_uppercase()});
    let (status, challenge) = send(&h.app, "POST", &base, &alex_token, Some(request.clone())).await;
    assert_eq!(status, 200, "{challenge}");
    let (recipient, code) = h.sender.0.lock().unwrap().take().unwrap();
    assert_eq!(recipient, work_email);
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let guess = serde_json::json!({"verificationId": challenge["verificationId"], "verificationCode": wrong});
    let (status, _) = send(&h.app, "POST", &verify, &alex_token, Some(guess)).await;
    assert_eq!(status, 400);
    let proof = serde_json::json!({"verificationId": challenge["verificationId"], "verificationCode": code});
    let (status, body) = send(&h.app, "POST", &verify, &alex_token, Some(proof.clone())).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["configured"]["admission"], "member");
    assert_eq!(h.role(&alex).await.as_deref(), Some("member"));
    let (status, _) = send(&h.app, "POST", &verify, &alex_token, Some(proof)).await;
    assert_eq!(status, 400, "a code is single use");

    // Another account cannot join with the same inbox.
    let (status, challenge) = send(&h.app, "POST", &base, &sam_token, Some(request)).await;
    assert_eq!(status, 200, "{challenge}");
    let (_, code) = h.sender.0.lock().unwrap().take().unwrap();
    let proof = serde_json::json!({"verificationId": challenge["verificationId"], "verificationCode": code});
    let (status, body) = send(&h.app, "POST", &verify, &sam_token, Some(proof)).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("organization_email_in_use"))
    );
    assert_eq!(h.role(&sam).await, None);
}
