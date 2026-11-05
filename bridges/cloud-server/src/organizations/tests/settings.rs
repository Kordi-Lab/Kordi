//! The organization settings route: any member reads, owners and admins
//! change.

use super::*;

#[tokio::test]
async fn owners_and_admins_change_device_code_sign_in() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "org_settings_owner").await;
    let (sam, sam_token) = signed_in(&pool, "org_settings_member").await;
    let organization = team(&pool, &alex).await;
    let (status, body) = add(&app, &alex_token, &organization, &sam, "member").await;
    assert_eq!(status, 201, "{body}");
    let path = format!("{ORGS}/{organization}/settings");

    let (status, body) = send(&app, "GET", &path, &sam_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["settings"]["deviceCodeSignIn"], true);
    assert_eq!(body["settings"]["deviceCodeSignInDefault"], true);

    let off = Some(json!({ "deviceCodeSignIn": false }));
    let (status, body) = send(&app, "PATCH", &path, &sam_token, off.clone()).await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = send(&app, "PATCH", &path, &alex_token, off).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["settings"]["deviceCodeSignIn"], false);
    let blocked = crate::organizations::device_code_sign_in_blocked_by(&pool, &sam)
        .await
        .unwrap();
    assert_eq!(blocked.as_deref(), Some("Example team"));

    // null restores the default; anything else is refused.
    let reset = Some(json!({ "deviceCodeSignIn": null }));
    let (status, body) = send(&app, "PATCH", &path, &alex_token, reset).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["settings"]["deviceCodeSignIn"], true);
    let invalid = Some(json!({ "deviceCodeSignIn": "yes" }));
    let (status, _) = send(&app, "PATCH", &path, &alex_token, invalid).await;
    assert_eq!(status, 400);

    // Outsiders do not learn the organization exists.
    let (_, outsider) = signed_in(&pool, "org_settings_outsider").await;
    let (status, _) = send(&app, "GET", &path, &outsider, None).await;
    assert_eq!(status, 404);
}
