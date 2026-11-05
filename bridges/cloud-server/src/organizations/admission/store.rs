//! Database side of organization admission: startup sync of configured
//! organizations and admins, joining or renewing from verified evidence,
//! expiry of memberships whose verification or approval lapsed, and the
//! join-request retention purge.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::claim::{decide, proves_email, Decision, PriorAdmission, SignInEvidence};
use super::config::{ConfiguredOrganization, OrganizationAdmission, DEFAULT_RETENTION_DAYS};

pub(crate) type Tx<'a> = sqlx_core::transaction::Transaction<'a, Postgres>;

impl OrganizationAdmission {
    /// Startup sync: [`Self::sync_configured`], then every organization
    /// dropped from the file is retired. Idempotent, so every replica may
    /// run it.
    pub async fn sync(self, pool: &PgPool) -> Result<Self, sqlx_core::Error> {
        let mut synced = self.sync_configured(pool).await?;
        synced.orphaned = orphaned_ids(pool, &synced).await?;
        for organization_id in &synced.orphaned {
            retire_orphan(pool, organization_id).await?;
        }
        Ok(synced)
    }

    /// Creates or updates one team organization per configured id and keeps
    /// configured admins in step.
    pub async fn sync_configured(mut self, pool: &PgPool) -> Result<Self, sqlx_core::Error> {
        for org in &mut self.organizations {
            let rule = org.membership.require_member_owner;
            let (organization_id,): (String,) = query_as(
                "INSERT INTO cloud_organizations \
                     (organization_id, name, kind, config_id, member_owned_content) \
                 VALUES ($1, $2, 'team', $3, $4) \
                 ON CONFLICT (config_id) WHERE config_id IS NOT NULL \
                 DO UPDATE SET name = EXCLUDED.name, \
                     member_owned_content = EXCLUDED.member_owned_content \
                 RETURNING organization_id",
            )
            .bind(format!("org_{}", uuid::Uuid::new_v4().simple()))
            .bind(&org.display_name)
            .bind(&org.id)
            .bind(rule)
            .fetch_one(pool)
            .await?;
            if rule {
                // The owner-eligibility rule (migration 0168) applies at once.
                query("SELECT cloud_reassign_ineligible_content($1, NULL)")
                    .bind(&organization_id)
                    .execute(pool)
                    .await?;
            }
            org.organization_id = organization_id;
            sync_admins(pool, org).await?;
        }
        Ok(self)
    }
}

/// Database organizations whose configuration id is not in `admission`.
pub(super) async fn orphaned_ids(
    pool: &PgPool,
    admission: &OrganizationAdmission,
) -> Result<Vec<String>, sqlx_core::Error> {
    let configured: Vec<&str> = admission
        .organizations
        .iter()
        .map(|o| o.id.as_str())
        .collect();
    let rows: Vec<(String,)> = query_as(
        "SELECT organization_id FROM cloud_organizations \
         WHERE config_id IS NOT NULL AND NOT (config_id = ANY($1)) ORDER BY organization_id",
    )
    .bind(&configured)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Ends every admitted membership and configured admin of an organization
/// no longer in the file, and purges its join requests after the default
/// retention. Running it again only purges.
pub(super) async fn retire_orphan(
    pool: &PgPool,
    organization_id: &str,
) -> Result<(), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    query(
        "UPDATE cloud_organization_members SET configured_admin = false, \
           configured_admin_email = NULL WHERE organization_id = $1 AND configured_admin",
    )
    .bind(organization_id)
    .execute(&mut *tx)
    .await?;
    query(
        "UPDATE cloud_organization_admissions \
         SET lapsed_at = now(), lapse_reason = 'organization_removed' \
         WHERE organization_id = $1 AND lapsed_at IS NULL",
    )
    .bind(organization_id)
    .execute(&mut *tx)
    .await?;
    let members: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_organization_members \
         WHERE organization_id = $1 AND role <> 'owner'",
    )
    .bind(organization_id)
    .fetch_all(&mut *tx)
    .await?;
    for (account_id,) in &members {
        end_membership(&mut tx, organization_id, account_id).await?;
    }
    purge_requests(&mut tx, organization_id, DEFAULT_RETENTION_DAYS).await?;
    tx.commit().await
}

/// Grants admin to listed account ids with an account. Admins listed by
/// email are granted only at a qualifying sign-in (see
/// [`ensure_configured_admin`]) and stay while their granting email is
/// listed. A disabled organization has no configured admins. Delisted
/// admins keep a plain membership only while an admission backs it.
async fn sync_admins(pool: &PgPool, org: &ConfiguredOrganization) -> Result<(), sqlx_core::Error> {
    let open = org.state.admits();
    let (ids, emails) = if open {
        (org.admins.account_ids.clone(), org.admins.emails.clone())
    } else {
        (Vec::new(), Vec::new())
    };
    let mut tx = pool.begin().await?;
    let existing: Vec<(String,)> =
        query_as("SELECT account_id FROM cloud_accounts WHERE account_id = ANY($1)")
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;
    for (account_id,) in &existing {
        grant_admin(&mut tx, &org.organization_id, account_id, None).await?;
    }
    let delisted: Vec<(String, String, bool)> = query_as(
        "SELECT m.account_id, m.role, EXISTS (SELECT 1 FROM cloud_organization_admissions a \
                  WHERE a.organization_id = m.organization_id \
                    AND a.account_id = m.account_id AND a.lapsed_at IS NULL) \
         FROM cloud_organization_members m \
         WHERE m.organization_id = $1 AND m.configured_admin \
           AND NOT (m.account_id = ANY($2)) \
           AND NOT (m.configured_admin_email IS NOT NULL AND m.configured_admin_email = ANY($3))",
    )
    .bind(&org.organization_id)
    .bind(&ids)
    .bind(&emails)
    .fetch_all(&mut *tx)
    .await?;
    for (account_id, role, backed) in delisted {
        query(
            "UPDATE cloud_organization_members SET configured_admin = false, \
               configured_admin_email = NULL, \
               role = CASE WHEN role = 'owner' THEN 'owner' ELSE 'member' END \
             WHERE organization_id = $1 AND account_id = $2",
        )
        .bind(&org.organization_id)
        .bind(&account_id)
        .execute(&mut *tx)
        .await?;
        if !backed && role != "owner" {
            end_membership(&mut tx, &org.organization_id, &account_id).await?;
        }
    }
    tx.commit().await
}

async fn grant_admin(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
    by_email: Option<&str>,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_organization_members \
           (organization_id, account_id, role, configured_admin, configured_admin_email) \
         VALUES ($1, $2, 'admin', true, $3) \
         ON CONFLICT (organization_id, account_id) DO UPDATE SET configured_admin = true, \
           configured_admin_email = COALESCE(EXCLUDED.configured_admin_email, \
                                             cloud_organization_members.configured_admin_email), \
           role = CASE WHEN cloud_organization_members.role = 'owner' THEN 'owner' ELSE 'admin' END",
    )
    .bind(organization_id)
    .bind(account_id)
    .bind(by_email)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Grants admin when the account is listed by id, or by an email that this
/// sign-in proved under the organization's own rules (an email code, or an
/// auto-join method with its hosted-domain rule). Disabled organizations
/// have no configured admins.
pub(super) async fn ensure_configured_admin(
    pool: &PgPool,
    org: &ConfiguredOrganization,
    account_id: &str,
    evidence: &SignInEvidence<'_>,
) -> Result<(), sqlx_core::Error> {
    if !org.state.admits() {
        return Ok(());
    }
    let by_id = org.admins.account_ids.iter().any(|id| id == account_id);
    let by_email = evidence
        .email
        .filter(|email| org.admins.emails.iter().any(|e| e == email))
        .filter(|_| proves_email(org, evidence));
    if !by_id && by_email.is_none() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    grant_admin(&mut tx, &org.organization_id, account_id, by_email).await?;
    tx.commit().await
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyOutcome {
    Joined,
    Renewed,
    Ignored,
    /// Another account holds an active membership with this email.
    EmailInUse,
    /// An admin removed the account; only a join request admits it again.
    Removed,
}

/// Applies `evidence` to `org` for `account_id`: joins, renews, or does
/// nothing. The admission row is locked so concurrent sign-ins serialize.
pub(super) async fn apply_evidence(
    pool: &PgPool,
    org: &ConfiguredOrganization,
    account_id: &str,
    evidence: &SignInEvidence<'_>,
) -> Result<VerifyOutcome, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let prior: Option<(Option<String>,)> = query_as(
        "SELECT lapse_reason FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id = $2 FOR UPDATE",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let recorded = match prior {
        None => PriorAdmission::None,
        Some((Some(reason),)) if reason == "removed" => PriorAdmission::Removed,
        Some(_) => PriorAdmission::Recorded,
    };
    if recorded == PriorAdmission::Removed {
        return Ok(VerifyOutcome::Removed);
    }
    if decide(org, evidence, recorded) == Decision::Ignore {
        return Ok(VerifyOutcome::Ignored);
    }
    let email = evidence.email.unwrap_or_default();
    let key = org.email_key(email);
    let in_use: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id <> $2 AND source = 'domain_claim' \
           AND lapsed_at IS NULL AND email_key = $3",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?;
    if in_use.is_some() {
        return Ok(VerifyOutcome::EmailInUse);
    }
    query(
        "INSERT INTO cloud_organization_admissions \
         (organization_id, account_id, source, verified_email, email_key, verification_method, \
          verified_at) \
         VALUES ($1, $2, 'domain_claim', $3, $5, $4, now()) \
         ON CONFLICT (organization_id, account_id) DO UPDATE SET \
           source = 'domain_claim', verified_email = EXCLUDED.verified_email, \
           email_key = EXCLUDED.email_key, \
           verification_method = EXCLUDED.verification_method, verified_at = now(), \
           expires_at = NULL, approved_by_account_id = NULL, lapsed_at = NULL, lapse_reason = NULL",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .bind(email)
    .bind(evidence.method.as_str())
    .bind(&key)
    .execute(&mut *tx)
    .await?;
    let inserted = add_member(&mut tx, &org.organization_id, account_id).await?;
    tx.commit().await?;
    Ok(if inserted {
        VerifyOutcome::Joined
    } else {
        VerifyOutcome::Renewed
    })
}

/// Adds a plain membership; returns whether it was new. A membership whose
/// end date passed (migration 0168) but that the sweep has not removed yet
/// counts as gone, so it starts again as a lasting plain membership.
pub(super) async fn add_member(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let result = query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member') ON CONFLICT (organization_id, account_id) \
         DO UPDATE SET role = 'member', expires_at = NULL, joined_at = now() \
         WHERE cloud_organization_members.expires_at <= now()",
    )
    .bind(organization_id)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Ends the memberships in `org` whose verification interval or approval
/// expiry has passed; `only` limits the sweep to one account. Returns the
/// accounts whose membership ended.
pub(super) async fn expire_due(
    pool: &PgPool,
    org: &ConfiguredOrganization,
    only: Option<&str>,
) -> Result<Vec<String>, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    // Month arithmetic follows the session time zone; pin it so every
    // replica computes the same due time.
    query("SET LOCAL TimeZone = 'UTC'")
        .execute(&mut *tx)
        .await?;
    let lapsed: Vec<(String,)> = query_as(
        "UPDATE cloud_organization_admissions SET lapsed_at = now(), \
           lapse_reason = CASE WHEN expires_at IS NOT NULL AND expires_at <= now() \
             THEN 'approval_expired' ELSE 'reverification_due' END \
         WHERE organization_id = $1 AND lapsed_at IS NULL \
           AND ($3::text IS NULL OR account_id = $3) \
           AND ((expires_at IS NOT NULL AND expires_at <= now()) \
             OR (source = 'domain_claim' AND $2::int IS NOT NULL \
                 AND verified_at + make_interval(months => $2::int) <= now())) \
         RETURNING account_id",
    )
    .bind(&org.organization_id)
    .bind(org.reverify_interval_months.map(|m| m as i32))
    .bind(only)
    .fetch_all(&mut *tx)
    .await?;
    let lapsed: Vec<String> = lapsed.into_iter().map(|(id,)| id).collect();
    for account_id in &lapsed {
        end_membership(&mut tx, &org.organization_id, account_id).await?;
    }
    tx.commit().await?;
    Ok(lapsed)
}

/// Removal through the members API of an organization from the file: the
/// admission lapses (`removed`), so the account no longer holds its verified
/// email and does not rejoin automatically; an approved join request admits
/// it again. Configured admins are managed by the file only.
pub(crate) async fn remove_admitted_member(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<(), crate::organizations::ApiError> {
    let server_error = |_| crate::organizations::server_error();
    let (configured_admin,): (bool,) = query_as(
        "SELECT configured_admin FROM cloud_organization_members \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(organization_id)
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(server_error)?;
    if configured_admin {
        return Err(crate::organizations::err(
            "configured_admin",
            "This admin is set by deployment configuration.",
            axum::http::StatusCode::CONFLICT,
        ));
    }
    query(
        "UPDATE cloud_organization_admissions SET lapsed_at = now(), lapse_reason = 'removed' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(organization_id)
    .bind(account_id)
    .execute(&mut **tx)
    .await
    .map_err(server_error)?;
    end_membership(tx, organization_id, account_id)
        .await
        .map_err(server_error)
}

/// The one place an admitted membership ends. Configured admins keep their
/// membership. Content ownership rules that follow membership (for example
/// moving an owner's records back to their personal organization) belong
/// here, inside the same transaction.
pub(crate) async fn end_membership(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "DELETE FROM cloud_organization_members \
         WHERE organization_id = $1 AND account_id = $2 AND NOT configured_admin",
    )
    .bind(organization_id)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    query(
        "INSERT INTO cloud_audit_events (event_id, account_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, 'organization.membership_lapsed', $3, $4)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(serde_json::json!({ "organizationId": organization_id }).to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Deletes join requests, with their field values, older than the
/// organization's retention period. Returns how many were deleted.
pub(super) async fn purge_join_requests(
    pool: &PgPool,
    org: &ConfiguredOrganization,
) -> Result<u64, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let deleted = purge_requests(&mut tx, &org.organization_id, org.request_retention_days).await?;
    tx.commit().await?;
    Ok(deleted)
}

async fn purge_requests(
    tx: &mut Tx<'_>,
    organization_id: &str,
    retention_days: u32,
) -> Result<u64, sqlx_core::Error> {
    let result = query(
        "DELETE FROM cloud_organization_join_requests \
         WHERE organization_id = $1 AND created_at <= now() - make_interval(days => $2::int)",
    )
    .bind(organization_id)
    .bind(retention_days as i32)
    .execute(&mut **tx)
    .await?;
    Ok(result.rows_affected())
}

/// One sweep over every configured organization, disabled ones included, so
/// a membership never outlives its verification, and over organizations
/// removed from the file.
pub async fn sweep(pool: &PgPool, admission: &OrganizationAdmission) {
    for organization_id in &admission.orphaned {
        if let Err(error) = retire_orphan(pool, organization_id).await {
            eprintln!("[organization admission] retire {organization_id}: {error}");
        }
    }
    for org in &admission.organizations {
        if let Err(error) = expire_due(pool, org, None).await {
            eprintln!("[organization admission] expire {}: {error}", org.id);
        }
        if let Err(error) = purge_join_requests(pool, org).await {
            eprintln!("[organization admission] purge {}: {error}", org.id);
        }
    }
}
