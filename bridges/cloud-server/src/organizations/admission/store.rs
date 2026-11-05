//! Database side of organization admission: startup sync of configured
//! organizations and admins, joining or renewing from verified evidence,
//! expiry of memberships whose verification or approval lapsed, and the
//! join-request retention purge.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::claim::{decide, Decision, PriorAdmission, SignInEvidence};
use super::config::{ConfiguredOrganization, OrganizationAdmission};

pub(super) type Tx<'a> = sqlx_core::transaction::Transaction<'a, Postgres>;

impl OrganizationAdmission {
    /// Creates or updates one team organization per configured id and keeps
    /// configured admins in step. Idempotent, so every replica may run it.
    pub async fn sync(mut self, pool: &PgPool) -> Result<Self, sqlx_core::Error> {
        for org in &mut self.organizations {
            let (organization_id,): (String,) = query_as(
                "INSERT INTO cloud_organizations (organization_id, name, kind, config_id) \
                 VALUES ($1, $2, 'team', $3) \
                 ON CONFLICT (config_id) WHERE config_id IS NOT NULL \
                 DO UPDATE SET name = EXCLUDED.name \
                 RETURNING organization_id",
            )
            .bind(format!("org_{}", uuid::Uuid::new_v4().simple()))
            .bind(&org.display_name)
            .bind(&org.id)
            .fetch_one(pool)
            .await?;
            org.organization_id = organization_id;
            sync_admins(pool, org).await?;
        }
        Ok(self)
    }
}

/// Grants admin to every configured admin with an account and takes the
/// flag from accounts no longer listed. A former admin keeps a plain
/// membership only while an admission record still backs it.
async fn sync_admins(pool: &PgPool, org: &ConfiguredOrganization) -> Result<(), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let listed: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_accounts \
         WHERE account_id = ANY($1) \
            OR (lower(primary_email) = ANY($2) AND primary_email_verified_at IS NOT NULL)",
    )
    .bind(&org.admins.account_ids)
    .bind(&org.admins.emails)
    .fetch_all(&mut *tx)
    .await?;
    let listed: Vec<String> = listed.into_iter().map(|(id,)| id).collect();
    for account_id in &listed {
        grant_admin(&mut tx, &org.organization_id, account_id).await?;
    }
    query(
        "DELETE FROM cloud_organization_members m \
         WHERE m.organization_id = $1 AND m.configured_admin AND NOT (m.account_id = ANY($2)) \
           AND NOT EXISTS (SELECT 1 FROM cloud_organization_admissions a \
                           WHERE a.organization_id = m.organization_id \
                             AND a.account_id = m.account_id AND a.lapsed_at IS NULL)",
    )
    .bind(&org.organization_id)
    .bind(&listed)
    .execute(&mut *tx)
    .await?;
    query(
        "UPDATE cloud_organization_members SET configured_admin = false, role = 'member' \
         WHERE organization_id = $1 AND configured_admin AND NOT (account_id = ANY($2))",
    )
    .bind(&org.organization_id)
    .bind(&listed)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

async fn grant_admin(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role, configured_admin) \
         VALUES ($1, $2, 'admin', true) \
         ON CONFLICT (organization_id, account_id) DO UPDATE SET configured_admin = true, \
           role = CASE WHEN cloud_organization_members.role = 'owner' THEN 'owner' ELSE 'admin' END",
    )
    .bind(organization_id)
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Grants admin when the account is listed by id or by one of its verified
/// emails, so an admin who signs up after startup is recognized.
pub(super) async fn ensure_configured_admin(
    pool: &PgPool,
    org: &ConfiguredOrganization,
    account_id: &str,
    verified_email: Option<&str>,
) -> Result<(), sqlx_core::Error> {
    let listed = org.admins.account_ids.iter().any(|id| id == account_id)
        || verified_email.is_some_and(|email| org.admins.emails.iter().any(|e| e == email));
    if !listed {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    grant_admin(&mut tx, &org.organization_id, account_id).await?;
    tx.commit().await
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyOutcome {
    Joined,
    Renewed,
    Ignored,
    /// Another account holds an active membership with this email.
    EmailInUse,
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
    let prior: Option<(Option<chrono::DateTime<Utc>>,)> = query_as(
        "SELECT lapsed_at FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id = $2 FOR UPDATE",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let recorded = if prior.is_some() {
        PriorAdmission::Recorded
    } else {
        PriorAdmission::None
    };
    if decide(org, evidence, recorded) == Decision::Ignore {
        return Ok(VerifyOutcome::Ignored);
    }
    let email = evidence.email.unwrap_or_default();
    let in_use: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_organization_admissions \
         WHERE organization_id = $1 AND account_id <> $2 AND source = 'domain_claim' \
           AND lapsed_at IS NULL AND lower(verified_email) = $3",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .bind(email)
    .fetch_optional(&mut *tx)
    .await?;
    if in_use.is_some() {
        return Ok(VerifyOutcome::EmailInUse);
    }
    query(
        "INSERT INTO cloud_organization_admissions \
         (organization_id, account_id, source, verified_email, verification_method, verified_at) \
         VALUES ($1, $2, 'domain_claim', $3, $4, now()) \
         ON CONFLICT (organization_id, account_id) DO UPDATE SET \
           source = 'domain_claim', verified_email = EXCLUDED.verified_email, \
           verification_method = EXCLUDED.verification_method, verified_at = now(), \
           expires_at = NULL, lapsed_at = NULL, lapse_reason = NULL",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .bind(email)
    .bind(evidence.method.as_str())
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

/// Adds a plain membership; returns whether it was new.
pub(super) async fn add_member(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let result = query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member') ON CONFLICT (organization_id, account_id) DO NOTHING",
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

/// The one place an admitted membership ends. Configured admins keep their
/// membership. Content ownership rules that follow membership (for example
/// moving an owner's records back to their personal organization) belong
/// here, inside the same transaction.
pub(super) async fn end_membership(
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
    let result = query(
        "DELETE FROM cloud_organization_join_requests \
         WHERE organization_id = $1 AND created_at <= now() - make_interval(days => $2::int)",
    )
    .bind(&org.organization_id)
    .bind(org.request_retention_days as i32)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// One sweep over every configured organization, disabled ones included, so
/// a membership never outlives its verification.
pub async fn sweep(pool: &PgPool, admission: &OrganizationAdmission) {
    for org in &admission.organizations {
        if let Err(error) = expire_due(pool, org, None).await {
            eprintln!("[organization admission] expire {}: {error}", org.id);
        }
        if let Err(error) = purge_join_requests(pool, org).await {
            eprintln!("[organization admission] purge {}: {error}", org.id);
        }
    }
}
