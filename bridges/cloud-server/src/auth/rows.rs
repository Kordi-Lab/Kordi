use chrono::{DateTime, NaiveDate, Utc};
use sqlx_core::{from_row::FromRow, row::Row};
use sqlx_postgres::PgRow;

/// Columns for [`AccountRecordRow`], selected from `cloud_accounts` (or the
/// row an `UPDATE ... RETURNING` produces).
pub(super) const ACCOUNT_RECORD_COLUMNS: &str = "account_id, \
    COALESCE(public_handle, public_account_number::TEXT) AS kordi_id, display_name, \
    primary_email, avatar_url, password_hash, avatar_source, avatar_style, avatar_seed, \
    avatar_renderer_version, avatar_version, avatar_updated_at, about, location, time_zone, \
    website";

/// [`ACCOUNT_RECORD_COLUMNS`] plus the columns of [`OwnerAccountRecordRow`].
pub(super) const OWNER_ACCOUNT_RECORD_COLUMNS: &str = "account_id, \
    COALESCE(public_handle, public_account_number::TEXT) AS kordi_id, display_name, \
    primary_email, avatar_url, password_hash, avatar_source, avatar_style, avatar_seed, \
    avatar_renderer_version, avatar_version, avatar_updated_at, about, location, time_zone, \
    website, primary_email_verified_at IS NOT NULL AS primary_email_verified, \
    public_account_number::TEXT AS account_number, birthday, public_handle_changed_at";

/// An account as anyone who may see it sees it.
pub(super) struct AccountRecordRow {
    pub(super) account_id: String,
    /// The chosen handle, or the public account number when none is set.
    pub(super) kordi_id: String,
    pub(super) display_name: Option<String>,
    pub(super) primary_email: Option<String>,
    pub(super) avatar_url: Option<String>,
    pub(super) password_hash: Option<String>,
    pub(super) avatar_source: String,
    pub(super) avatar_style: String,
    pub(super) avatar_seed: String,
    pub(super) avatar_renderer_version: String,
    pub(super) avatar_version: i64,
    pub(super) avatar_updated_at: String,
    pub(super) about: Option<String>,
    pub(super) location: Option<String>,
    pub(super) time_zone: Option<String>,
    pub(super) website: Option<String>,
}

impl<'row> FromRow<'row, PgRow> for AccountRecordRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            account_id: row.try_get("account_id")?,
            kordi_id: row.try_get("kordi_id")?,
            display_name: row.try_get("display_name")?,
            primary_email: row.try_get("primary_email")?,
            avatar_url: row.try_get("avatar_url")?,
            password_hash: row.try_get("password_hash")?,
            avatar_source: row.try_get("avatar_source")?,
            avatar_style: row.try_get("avatar_style")?,
            avatar_seed: row.try_get("avatar_seed")?,
            avatar_renderer_version: row.try_get("avatar_renderer_version")?,
            avatar_version: row.try_get("avatar_version")?,
            avatar_updated_at: row.try_get("avatar_updated_at")?,
            about: row.try_get("about")?,
            location: row.try_get("location")?,
            time_zone: row.try_get("time_zone")?,
            website: row.try_get("website")?,
        })
    }
}

/// [`AccountRecordRow`] with the state only the account's owner may see.
pub(super) struct OwnerAccountRecordRow {
    pub(super) account: AccountRecordRow,
    pub(super) primary_email_verified: bool,
    /// The nine-digit public account number, even when a handle is set.
    pub(super) account_number: String,
    pub(super) birthday: Option<NaiveDate>,
    pub(super) public_handle_changed_at: Option<DateTime<Utc>>,
}

impl<'row> FromRow<'row, PgRow> for OwnerAccountRecordRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            account: AccountRecordRow::from_row(row)?,
            primary_email_verified: row.try_get("primary_email_verified")?,
            account_number: row.try_get("account_number")?,
            birthday: row.try_get("birthday")?,
            public_handle_changed_at: row.try_get("public_handle_changed_at")?,
        })
    }
}

/// One contact of the signed-in account, with the contact's default agent.
pub(super) struct ContactListRow {
    pub(super) account_id: String,
    pub(super) kordi_id: String,
    pub(super) display_name: Option<String>,
    pub(super) avatar_url: Option<String>,
    pub(super) created_at: String,
    pub(super) about: Option<String>,
    pub(super) location: Option<String>,
    pub(super) time_zone: Option<String>,
    pub(super) website: Option<String>,
    pub(super) agent: DefaultAgentProfileRow,
}

impl<'row> FromRow<'row, PgRow> for ContactListRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            account_id: row.try_get("account_id")?,
            kordi_id: row.try_get("kordi_id")?,
            display_name: row.try_get("display_name")?,
            avatar_url: row.try_get("avatar_url")?,
            created_at: row.try_get("created_at")?,
            about: row.try_get("about")?,
            location: row.try_get("location")?,
            time_zone: row.try_get("time_zone")?,
            website: row.try_get("website")?,
            agent: (
                row.try_get("agent_owner_account_id")?,
                row.try_get("agent_display_name")?,
                row.try_get("agent_avatar_url")?,
                row.try_get("agent_avatar_source")?,
                row.try_get("agent_avatar_style")?,
                row.try_get("agent_avatar_seed")?,
                row.try_get("agent_avatar_renderer_version")?,
                row.try_get("agent_avatar_version")?,
                row.try_get("agent_avatar_updated_at")?,
            ),
        })
    }
}

pub(super) type DefaultAgentProfileRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    String,
    i64,
    String,
);
pub(super) type ContactRequestRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);
