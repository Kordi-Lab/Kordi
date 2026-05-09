use rusqlite::{Connection, OptionalExtension};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OAuthProviderId {
    GitHub,
    Google,
    X,
}

impl OAuthProviderId {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "github" => Some(Self::GitHub),
            "google" => Some(Self::Google),
            "x" | "twitter" => Some(Self::X),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::Google => "google",
            Self::X => "x",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthProviderDescriptor {
    pub id: OAuthProviderId,
    pub display_name: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OAuthProviderRegistry {
    providers: Vec<OAuthProviderDescriptor>,
}

impl OAuthProviderRegistry {
    pub fn new(providers: Vec<OAuthProviderDescriptor>) -> Self {
        Self { providers }
    }

    pub fn providers(&self) -> &[OAuthProviderDescriptor] {
        &self.providers
    }

    pub fn provider(&self, id: &str) -> Option<&OAuthProviderDescriptor> {
        let id = OAuthProviderId::parse(id)?;
        self.providers.iter().find(|provider| provider.id == id)
    }
}

pub fn default_oauth_provider_registry() -> OAuthProviderRegistry {
    OAuthProviderRegistry::new(vec![
        OAuthProviderDescriptor {
            id: OAuthProviderId::GitHub,
            display_name: "GitHub",
        },
        OAuthProviderDescriptor {
            id: OAuthProviderId::Google,
            display_name: "Google",
        },
        OAuthProviderDescriptor {
            id: OAuthProviderId::X,
            display_name: "X",
        },
    ])
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountIdentityUpsert {
    pub provider: OAuthProviderId,
    pub provider_subject: String,
    pub provider_username: Option<String>,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub email_verified: bool,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountIdentityRecord {
    pub account_id: String,
    pub identity_id: String,
    pub created_account: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudDeviceRegistration {
    pub account_id: String,
    pub device_name: Option<String>,
    pub device_public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudDeviceRecord {
    pub device_id: String,
    pub account_id: String,
}

fn new_prefixed_id(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v4().simple())
}

pub fn upsert_account_identity(
    conn: &Connection,
    input: AccountIdentityUpsert,
) -> Result<AccountIdentityRecord, rusqlite::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.unchecked_transaction()?;
    let provider = input.provider.as_str();
    let existing = tx
        .query_row(
            "SELECT identity_id, account_id FROM cloud_account_identities WHERE provider = ?1 AND provider_subject = ?2",
            rusqlite::params![provider, input.provider_subject],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;

    let (account_id, identity_id, created_account) = if let Some((identity_id, account_id)) =
        existing
    {
        tx.execute(
            "UPDATE cloud_accounts SET display_name = COALESCE(?1, display_name), primary_email = COALESCE(?2, primary_email), avatar_url = COALESCE(?3, avatar_url), updated_at = ?4 WHERE account_id = ?5",
            rusqlite::params![input.display_name, input.email, input.avatar_url, now, account_id],
        )?;
        tx.execute(
            "UPDATE cloud_account_identities SET provider_username = ?1, email = ?2, email_verified = ?3, avatar_url = ?4, updated_at = ?5 WHERE identity_id = ?6",
            rusqlite::params![
                input.provider_username,
                input.email,
                if input.email_verified { 1 } else { 0 },
                input.avatar_url,
                now,
                identity_id,
            ],
        )?;
        (account_id, identity_id, false)
    } else {
        let account_id = new_prefixed_id("kca");
        let identity_id = new_prefixed_id("kci");
        tx.execute(
            "INSERT INTO cloud_accounts (account_id, display_name, primary_email, avatar_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![account_id, input.display_name, input.email, input.avatar_url, now],
        )?;
        tx.execute(
            "INSERT INTO cloud_account_identities (identity_id, account_id, provider, provider_subject, provider_username, email, email_verified, avatar_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            rusqlite::params![
                identity_id,
                account_id,
                provider,
                input.provider_subject,
                input.provider_username,
                input.email,
                if input.email_verified { 1 } else { 0 },
                input.avatar_url,
                now,
            ],
        )?;
        (account_id, identity_id, true)
    };

    tx.commit()?;
    Ok(AccountIdentityRecord {
        account_id,
        identity_id,
        created_account,
    })
}

pub fn register_cloud_device(
    conn: &Connection,
    input: CloudDeviceRegistration,
) -> Result<CloudDeviceRecord, rusqlite::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let device_id = new_prefixed_id("kcd");
    conn.execute(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![
            device_id,
            input.account_id,
            input.device_name,
            input.device_public_key,
            now,
        ],
    )?;
    Ok(CloudDeviceRecord {
        device_id,
        account_id: input.account_id,
    })
}

pub fn cloud_device_belongs_to_account(
    conn: &Connection,
    account_id: &str,
    device_id: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM cloud_devices WHERE account_id = ?1 AND device_id = ?2 AND revoked_at IS NULL",
            rusqlite::params![account_id, device_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oauth_provider_ids_normalize_for_supported_providers() {
        assert_eq!(
            OAuthProviderId::parse(" GitHub ").unwrap().as_str(),
            "github"
        );
        assert_eq!(OAuthProviderId::parse("GOOGLE").unwrap().as_str(), "google");
        assert_eq!(OAuthProviderId::parse("twitter").unwrap().as_str(), "x");
        assert!(OAuthProviderId::parse("mastodon").is_none());
    }

    #[test]
    fn default_oauth_provider_registry_exposes_core_login_providers() {
        let registry = default_oauth_provider_registry();
        let providers: Vec<&str> = registry
            .providers()
            .iter()
            .map(|provider| provider.id.as_str())
            .collect();

        assert_eq!(providers, vec!["github", "google", "x"]);
        assert_eq!(registry.provider("github").unwrap().display_name, "GitHub");
        assert_eq!(registry.provider("google").unwrap().display_name, "Google");
        assert_eq!(registry.provider("x").unwrap().display_name, "X");
    }

    #[test]
    fn upsert_account_identity_creates_and_reuses_cloud_account() {
        let conn = rusqlite::Connection::open_in_memory().expect("open db");
        super::super::init_server_db(&conn).expect("init db");

        let first = upsert_account_identity(
            &conn,
            AccountIdentityUpsert {
                provider: OAuthProviderId::GitHub,
                provider_subject: "gh_123".to_string(),
                provider_username: Some("octo".to_string()),
                display_name: Some("Octo Cat".to_string()),
                email: Some("octo@example.com".to_string()),
                email_verified: true,
                avatar_url: Some("https://example.com/octo.png".to_string()),
            },
        )
        .expect("first upsert");
        let second = upsert_account_identity(
            &conn,
            AccountIdentityUpsert {
                provider: OAuthProviderId::GitHub,
                provider_subject: "gh_123".to_string(),
                provider_username: Some("octocat".to_string()),
                display_name: Some("The Octocat".to_string()),
                email: Some("octocat@example.com".to_string()),
                email_verified: true,
                avatar_url: None,
            },
        )
        .expect("second upsert");

        assert_eq!(first.account_id, second.account_id);
        assert_eq!(first.identity_id, second.identity_id);
        assert!(first.created_account);
        assert!(!second.created_account);

        let account_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM cloud_accounts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(account_count, 1);
    }

    #[test]
    fn register_cloud_device_rejects_unknown_account() {
        let conn = rusqlite::Connection::open_in_memory().expect("open db");
        super::super::init_server_db(&conn).expect("init db");

        let result = register_cloud_device(
            &conn,
            CloudDeviceRegistration {
                account_id: "kca_missing".to_string(),
                device_name: Some("Unknown account device".to_string()),
                device_public_key: "device-public-key".to_string(),
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn register_cloud_device_belongs_to_existing_account() {
        let conn = rusqlite::Connection::open_in_memory().expect("open db");
        super::super::init_server_db(&conn).expect("init db");
        let account = upsert_account_identity(
            &conn,
            AccountIdentityUpsert {
                provider: OAuthProviderId::Google,
                provider_subject: "google_123".to_string(),
                provider_username: None,
                display_name: Some("Ada".to_string()),
                email: Some("ada@example.com".to_string()),
                email_verified: true,
                avatar_url: None,
            },
        )
        .expect("upsert identity");

        let device = register_cloud_device(
            &conn,
            CloudDeviceRegistration {
                account_id: account.account_id.clone(),
                device_name: Some("Ada's Mac".to_string()),
                device_public_key: "device-public-key".to_string(),
            },
        )
        .expect("register device");

        let saved_account: String = conn
            .query_row(
                "SELECT account_id FROM cloud_devices WHERE device_id = ?1",
                rusqlite::params![device.device_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(saved_account, account.account_id);
    }
}
