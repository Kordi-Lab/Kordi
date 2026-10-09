//! OAuth endpoints, scope sets, and the client-facing scope catalog for each
//! provider, as data.

use super::{ProviderSpec, ScopeParam};

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_AUTH_PARAMS: &[(&str, &str)] = &[
    ("access_type", "offline"),
    ("prompt", "consent"),
    ("include_granted_scopes", "true"),
];

const CALENDAR_READONLY: &str = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";

pub static GOOGLE_CALENDAR: ProviderSpec = ProviderSpec {
    id: "google_calendar",
    display_name: "Google Calendar",
    env_prefix: "GOOGLE",
    auth_url: GOOGLE_AUTH_URL,
    token_url: GOOGLE_TOKEN_URL,
    revoke_url: Some(GOOGLE_REVOKE_URL),
    // `calendar_list_events` reads; `calendar_respond` and
    // `calendar_create_event` write events.
    read_scopes: &[CALENDAR_READONLY],
    act_scopes: &[CALENDAR_EVENTS],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: GOOGLE_AUTH_PARAMS,
    catalog_scopes: &[
        (
            CALENDAR_READONLY,
            &[
                "google_calendar.events.read",
                "google_calendar.freebusy.read",
            ],
        ),
        (
            CALENDAR_EVENTS,
            &[
                "google_calendar.invitations.reply",
                "google_calendar.events.write",
            ],
        ),
    ],
};

const GMAIL_READONLY: &str = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND: &str = "https://www.googleapis.com/auth/gmail.send";

pub static GMAIL: ProviderSpec = ProviderSpec {
    id: "gmail",
    display_name: "Gmail",
    env_prefix: "GOOGLE",
    auth_url: GOOGLE_AUTH_URL,
    token_url: GOOGLE_TOKEN_URL,
    revoke_url: Some(GOOGLE_REVOKE_URL),
    // `gmail_search` and `gmail_read_message` read, and readonly also
    // covers the `users.watch` push subscription; `gmail_send` sends.
    read_scopes: &[GMAIL_READONLY],
    act_scopes: &[GMAIL_SEND],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: GOOGLE_AUTH_PARAMS,
    catalog_scopes: &[
        (
            GMAIL_READONLY,
            &["gmail.messages.read", "gmail.labels.read"],
        ),
        (GMAIL_SEND, &["gmail.messages.send"]),
    ],
};

pub static GITHUB: ProviderSpec = ProviderSpec {
    id: "github",
    display_name: "GitHub",
    env_prefix: "GITHUB",
    auth_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    // GitHub revokes OAuth app grants through a Basic-authenticated
    // `DELETE /applications/{client_id}/grant`; see `oauth2.rs`.
    revoke_url: Some("https://api.github.com/applications"),
    // GitHub OAuth apps have no read-only repository scope. The read grant
    // covers notifications and pull requests in public repositories. `repo`
    // (the act grant) gives full read and write access to every private
    // repository the person can reach; the consent text says so, and the
    // broker only runs the commenting tool with it.
    read_scopes: &["read:user", "notifications"],
    act_scopes: &["repo"],
    scope_param: ScopeParam::SpaceSeparated,
    supports_pkce: true,
    extra_auth_params: &[],
    catalog_scopes: &[
        (
            "notifications",
            &["github.notifications.read", "github.pulls.read"],
        ),
        ("repo", &["github.comments.write"]),
    ],
};

pub static SLACK: ProviderSpec = ProviderSpec {
    id: "slack",
    display_name: "Slack",
    env_prefix: "SLACK",
    auth_url: "https://slack.com/oauth/v2/authorize",
    token_url: "https://slack.com/api/oauth.v2.access",
    revoke_url: Some("https://slack.com/api/auth.revoke"),
    // `slack_read_channel` and polling read history in public and private
    // channels. Channels are chosen by id, so no list or user scopes.
    read_scopes: &["channels:history", "groups:history"],
    act_scopes: &["chat:write"],
    scope_param: ScopeParam::SlackUserScope,
    supports_pkce: false,
    extra_auth_params: &[],
    catalog_scopes: &[
        ("channels:history", &["slack.channels.read"]),
        ("groups:history", &["slack.channels.read"]),
        ("chat:write", &["slack.messages.write"]),
    ],
};

/// Every provider that can be connected today.
pub static PROVIDER_SPECS: [&ProviderSpec; 4] = [&GOOGLE_CALENDAR, &GMAIL, &GITHUB, &SLACK];

/// Providers the product names but that cannot be connected yet.
pub const NOT_YET_AVAILABLE_PROVIDERS: &[&str] = &["outlook"];

pub fn provider_spec(id: &str) -> Option<&'static ProviderSpec> {
    PROVIDER_SPECS.iter().copied().find(|spec| spec.id == id)
}
