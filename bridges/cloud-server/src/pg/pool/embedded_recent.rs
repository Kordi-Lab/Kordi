//! Embedded Postgres migrations from version 66 on, in version order.

use super::{migration_entry::migration, EmbeddedMigration};

/// Migrations from version 66 on.
pub(super) const RECENT_MIGRATIONS: &[EmbeddedMigration] = &[
    EmbeddedMigration {
        version: 66,
        description: "quarantine legacy support conversations",
        sql: include_str!("../../../migrations/0066_quarantine_legacy_support_conversations.sql"),
    },
    EmbeddedMigration {
        version: 67,
        description: "quarantine invalid support conversations",
        sql: include_str!("../../../migrations/0067_quarantine_invalid_support_conversations.sql"),
    },
    EmbeddedMigration {
        version: 68,
        description: "cloud agent fallback system prompts",
        sql: include_str!("../../../migrations/0068_cloud_agent_system_prompts.sql"),
    },
    EmbeddedMigration {
        version: 69,
        description: "account default agent profiles",
        sql: include_str!("../../../migrations/0069_default_agent_profiles.sql"),
    },
    EmbeddedMigration {
        version: 70,
        description: "expressive media deletion tombstones",
        sql: include_str!("../../../migrations/0070_expressive_media_deletions.sql"),
    },
    EmbeddedMigration {
        version: 71,
        description: "chat message edit and deletion",
        sql: include_str!("../../../migrations/0071_chat_message_mutations.sql"),
    },
    EmbeddedMigration {
        version: 72,
        description: "chat list preferences",
        sql: include_str!("../../../migrations/0072_chat_list_preferences.sql"),
    },
    EmbeddedMigration {
        version: 73,
        description: "chat manual unread preference",
        sql: include_str!("../../../migrations/0073_chat_manual_unread.sql"),
    },
    EmbeddedMigration {
        version: 74,
        description: "group space preferences",
        sql: include_str!("../../../migrations/0074_group_space_preferences.sql"),
    },
    EmbeddedMigration {
        version: 75,
        description: "chat group catalog",
        sql: include_str!("../../../migrations/0075_chat_group_catalog.sql"),
    },
    EmbeddedMigration {
        version: 76,
        description: "remove group session forks",
        sql: include_str!("../../../migrations/0076_remove_group_session_forks.sql"),
    },
    EmbeddedMigration {
        version: 77,
        description: "remove group personal titles",
        sql: include_str!("../../../migrations/0077_remove_group_personal_titles.sql"),
    },
    EmbeddedMigration {
        version: 78,
        description: "normalize group space ids",
        sql: include_str!("../../../migrations/0078_normalize_group_space_ids.sql"),
    },
    EmbeddedMigration {
        version: 79,
        description: "default group channel titles",
        sql: include_str!("../../../migrations/0079_default_group_channel_titles.sql"),
    },
    EmbeddedMigration {
        version: 80,
        description: "enforce canonical direct conversation identity",
        sql: include_str!("../../../migrations/0080_enforce_direct_conversation_identity.sql"),
    },
    EmbeddedMigration {
        version: 81,
        description: "agent_execution_ownership",
        sql: include_str!("../../../migrations/0081_agent_execution_ownership.sql"),
    },
    EmbeddedMigration {
        version: 82,
        description: "reconcile rolling digest schema",
        sql: include_str!("../../../migrations/0082_reconcile_rolling_digest.sql"),
    },
    EmbeddedMigration {
        version: 83,
        description: "model agent subsessions",
        sql: include_str!("../../../migrations/0083_model_agent_subsessions.sql"),
    },
    EmbeddedMigration {
        version: 84,
        description: "subsession conversations",
        sql: include_str!("../../../migrations/0084_subsession_conversations.sql"),
    },
    EmbeddedMigration {
        version: 85,
        description: "subsession execution clock",
        sql: include_str!("../../../migrations/0085_subsession_execution_clock.sql"),
    },
    EmbeddedMigration {
        version: 86,
        description: "per-member thread read cursors",
        sql: include_str!("../../../migrations/0086_thread_read_cursors.sql"),
    },
    EmbeddedMigration {
        version: 87,
        description: "immutable agent turn identity",
        sql: include_str!("../../../migrations/0087_agent_turn_identity.sql"),
    },
    EmbeddedMigration {
        version: 88,
        description: "indexed thread attention and independent unread totals",
        sql: include_str!("../../../migrations/0088_thread_attention.sql"),
    },
    EmbeddedMigration {
        version: 89,
        description: "preserve legacy conversation and execution identities",
        sql: include_str!("../../../migrations/0089_legacy_identity_compatibility.sql"),
    },
    EmbeddedMigration {
        version: 90,
        description: "recover historical channel names without exposing private titles",
        sql: include_str!("../../../migrations/0090_preserve_group_channel_names.sql"),
    },
    EmbeddedMigration {
        version: 91,
        description: "add independently scoped attachment reactions and private visibility",
        sql: include_str!("../../../migrations/0091_chat_attachment_actions.sql"),
    },
    EmbeddedMigration {
        version: 92,
        description: "retain independently scoped pin and unpin history",
        sql: include_str!("../../../migrations/0092_session_pin_history.sql"),
    },
    EmbeddedMigration {
        version: 93,
        description: "recover retained pin history without blocking live capture",
        sql: include_str!("../../../migrations/0093_backfill_session_pin_history.sql"),
    },
    EmbeddedMigration {
        version: 94,
        description: "shared plan cards for group-chat coordination",
        sql: include_str!("../../../migrations/0094_plan_cards.sql"),
    },
    EmbeddedMigration {
        version: 95,
        description: "pip conversation sweep state",
        sql: include_str!("../../../migrations/0095_pip_conversation_state.sql"),
    },
    EmbeddedMigration {
        version: 96,
        description: "plan card vote options",
        sql: include_str!("../../../migrations/0096_plan_card_options.sql"),
    },
    EmbeddedMigration {
        version: 97,
        description: "digest change tracking",
        sql: include_str!("../../../migrations/0097_digest_change_tracking.sql"),
    },
    EmbeddedMigration {
        version: 98,
        description: "digest failure backoff",
        sql: include_str!("../../../migrations/0098_digest_failure_backoff.sql"),
    },
    EmbeddedMigration {
        version: 99,
        description: "durable plan-card projection and immutable PiP context",
        sql: include_str!("../../../migrations/0099_plan_card_projection_and_pip_context.sql"),
    },
    EmbeddedMigration {
        version: 100,
        description: "provider auth profile labels",
        sql: include_str!("../../../migrations/0100_provider_auth_profile_labels.sql"),
    },
    EmbeddedMigration {
        version: 101,
        description: "provider auth model hint",
        sql: include_str!("../../../migrations/0101_provider_auth_model_hint.sql"),
    },
    EmbeddedMigration {
        version: 102,
        description: "provider auth login sessions",
        sql: include_str!("../../../migrations/0102_provider_auth_login_sessions.sql"),
    },
    EmbeddedMigration {
        version: 103,
        description: "provider auth login session method",
        sql: include_str!("../../../migrations/0103_provider_auth_login_session_method.sql"),
    },
    EmbeddedMigration {
        version: 104,
        description: "provider auth payload version",
        sql: include_str!("../../../migrations/0104_provider_auth_payload_version.sql"),
    },
    migration!(
        105,
        "provider auth snapshot readiness",
        "0105_provider_auth_snapshot_readiness.sql"
    ),
    migration!(
        106,
        "private OMP runtime replay state",
        "0106_omp_runtime_state.sql"
    ),
    migration!(
        107,
        "account-scoped desktop projects",
        "0107_chat_projects.sql"
    ),
    migration!(108, "session pin stacks", "0108_session_pin_stacks.sql"),
    migration!(109, "group avatars", "0109_group_avatars.sql"),
    migration!(110, "signup email codes", "0110_signup_email_codes.sql"),
    migration!(
        111,
        "account email verification",
        "0111_account_email_verification.sql"
    ),
    migration!(
        112,
        "session-bound realtime tickets",
        "0112_realtime_ticket_sessions.sql"
    ),
    migration!(
        113,
        "account email verification codes",
        "0113_account_email_codes.sql"
    ),
    migration!(114, "cloud connectors", "0114_cloud_connectors.sql"),
    migration!(
        115,
        "run trigger and connector tools",
        "0115_run_trigger_connector_tools.sql"
    ),
    migration!(
        116,
        "connector provider state",
        "0116_connector_provider_state.sql"
    ),
    migration!(117, "connector audience", "0117_run_connector_audience.sql"),
    migration!(
        118,
        "agent run stop requests",
        "0118_agent_run_stop_requests.sql"
    ),
    migration!(119, "account memories", "0119_account_memories.sql"),
];
