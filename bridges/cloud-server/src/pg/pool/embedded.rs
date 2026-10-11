//! Every embedded Postgres migration, in version order. Versions up to
//! 65 live here and later ones in `embedded_recent`.

use std::sync::LazyLock;

use super::{embedded_recent::RECENT_MIGRATIONS, migration_entry::migration, EmbeddedMigration};

/// Migrations up to version 65.
const EARLY_MIGRATIONS: &[EmbeddedMigration] = &[
    migration!(1, "initial cloud schema", "0001_initial.sql"),
    migration!(2, "cloud_attachments table", "0002_attachments.sql"),
    migration!(
        3,
        "cloud_contact_requests + approval flow",
        "0003_contact_requests.sql"
    ),
    migration!(4, "cloud_messages table", "0004_cloud_messages.sql"),
    migration!(5, "cloud OAuth state table", "0005_oauth_states.sql"),
    migration!(
        6,
        "allow self cloud messages",
        "0006_allow_self_cloud_messages.sql"
    ),
    migration!(
        7,
        "cloud message session ids",
        "0007_cloud_message_session_ids.sql"
    ),
    migration!(
        8,
        "cloud message attachment links",
        "0008_cloud_message_attachments.sql"
    ),
    migration!(9, "cloud sync events", "0009_cloud_sync_events.sql"),
    migration!(
        10,
        "cloud session forks lineage",
        "0010_cloud_session_forks.sql"
    ),
    migration!(
        11,
        "direct person cloud session ids",
        "0011_direct_person_session_ids.sql"
    ),
    EmbeddedMigration {
        version: 12,
        description: "cloud sync event session payloads",
        sql: include_str!("../../../migrations/0012_cloud_sync_event_session_payloads.sql"),
    },
    migration!(
        13,
        "cloud session activity",
        "0013_cloud_session_activity.sql"
    ),
    migration!(
        14,
        "cloud session visibility",
        "0014_cloud_session_visibility.sql"
    ),
    migration!(
        17,
        "cloud device presence",
        "0017_cloud_device_presence.sql"
    ),
    EmbeddedMigration {
        version: 18,
        description: "cloud agent fallback runs",
        sql: include_str!("../../../migrations/0018_cloud_agent_fallback_runs.sql"),
    },
    EmbeddedMigration {
        version: 19,
        description: "cloud agent provider auth snapshots",
        sql: include_str!("../../../migrations/0019_cloud_agent_provider_auth_snapshots.sql"),
    },
    EmbeddedMigration {
        version: 20,
        description: "cloud agent sandboxes",
        sql: include_str!("../../../migrations/0020_cloud_agent_sandboxes.sql"),
    },
    EmbeddedMigration {
        version: 21,
        description: "cloud agent run artifacts",
        sql: include_str!("../../../migrations/0021_cloud_agent_run_artifacts.sql"),
    },
    EmbeddedMigration {
        version: 22,
        description: "scheduled task tool",
        sql: include_str!("../../../migrations/0022_scheduled_task_tool.sql"),
    },
    EmbeddedMigration {
        version: 23,
        description: "cloud session pinned messages",
        sql: include_str!("../../../migrations/0023_cloud_session_pins.sql"),
    },
    EmbeddedMigration {
        version: 24,
        description: "backfill stranded scheduled tasks",
        sql: include_str!("../../../migrations/0024_backfill_stranded_scheduled_tasks.sql"),
    },
    EmbeddedMigration {
        version: 25,
        description: "cloud agent definitions",
        sql: include_str!("../../../migrations/0025_cloud_agent_definitions.sql"),
    },
    EmbeddedMigration {
        version: 26,
        description: "cloud agent participant sharing",
        sql: include_str!("../../../migrations/0026_cloud_agent_participant_sharing.sql"),
    },
    EmbeddedMigration {
        version: 28,
        description: "cloud read cursors",
        sql: include_str!("../../../migrations/0028_cloud_read_cursors.sql"),
    },
    EmbeddedMigration {
        version: 29,
        description: "backfill cloud read cursors",
        sql: include_str!("../../../migrations/0029_backfill_cloud_read_cursors.sql"),
    },
    EmbeddedMigration {
        version: 30,
        description: "mark self cloud messages read",
        sql: include_str!("../../../migrations/0030_mark_self_cloud_messages_read.sql"),
    },
    EmbeddedMigration {
        version: 31,
        description: "cloud message attachment previews",
        sql: include_str!("../../../migrations/0031_cloud_message_attachment_previews.sql"),
    },
    EmbeddedMigration {
        version: 32,
        description: "cloud message idempotency",
        sql: include_str!("../../../migrations/0032_cloud_message_idempotency.sql"),
    },
    EmbeddedMigration {
        version: 33,
        description: "cloud session titles",
        sql: include_str!("../../../migrations/0033_cloud_session_titles.sql"),
    },
    EmbeddedMigration {
        version: 35,
        description: "global support",
        sql: include_str!("../../../migrations/0035_global_support.sql"),
    },
    EmbeddedMigration {
        version: 36,
        description: "public Kordi ids and app invitations",
        sql: include_str!("../../../migrations/0036_public_kordi_ids_and_app_invitations.sql"),
    },
    EmbeddedMigration {
        version: 44,
        description: "group invitations",
        sql: include_str!("../../../migrations/0044_group_invitations.sql"),
    },
    EmbeddedMigration {
        version: 45,
        description: "cloud message server receive order",
        sql: include_str!("../../../migrations/0045_cloud_message_server_received_at.sql"),
    },
    EmbeddedMigration {
        version: 46,
        description: "cloud agent runtime routes",
        sql: include_str!("../../../migrations/0046_cloud_agent_runtime_routes.sql"),
    },
    EmbeddedMigration {
        version: 47,
        description: "create reliable canonical chat sync",
        sql: include_str!("../../../migrations/0047_reliable_chat_sync_v2.sql"),
    },
    EmbeddedMigration {
        version: 48,
        description: "backfill retained chat into canonical chat sync",
        sql: include_str!("../../../migrations/0048_backfill_reliable_chat_sync_v2.sql"),
    },
    EmbeddedMigration {
        version: 49,
        description: "relink migrated agent responses to canonical requests",
        sql: include_str!("../../../migrations/0049_relink_legacy_agent_responses.sql"),
    },
    EmbeddedMigration {
        version: 50,
        description: "canonical Cloud-agent artifact links",
        sql: include_str!("../../../migrations/0050_chat_v2_artifact_links.sql"),
    },
    EmbeddedMigration {
        version: 51,
        description: "retire superseded chat storage and compatibility bridges",
        sql: include_str!("../../../migrations/0051_retire_chat_sync_v1.sql"),
    },
    EmbeddedMigration {
        version: 52,
        description: "device authorizations and idempotent management operations",
        sql: include_str!("../../../migrations/0052_device_authorizations.sql"),
    },
    EmbeddedMigration {
        version: 53,
        description: "coarse device location metadata",
        sql: include_str!("../../../migrations/0053_device_approximate_location.sql"),
    },
    EmbeddedMigration {
        version: 54,
        description: "coarse OAuth device location metadata",
        sql: include_str!("../../../migrations/0054_oauth_device_approximate_location.sql"),
    },
    EmbeddedMigration {
        version: 55,
        description: "call state and Apple notification tokens",
        sql: include_str!("../../../migrations/0055_calls.sql"),
    },
    EmbeddedMigration {
        version: 56,
        description: "deduplicated message notification events",
        sql: include_str!("../../../migrations/0056_message_notification_events.sql"),
    },
    EmbeddedMigration {
        version: 57,
        description: "durable per-device message notification delivery",
        sql: include_str!("../../../migrations/0057_message_notification_deliveries.sql"),
    },
    EmbeddedMigration {
        version: 58,
        description: "verified meme media metadata",
        sql: include_str!("../../../migrations/0058_meme_media_metadata.sql"),
    },
    EmbeddedMigration {
        version: 59,
        description: "account expressive media library",
        sql: include_str!("../../../migrations/0059_expressive_media_library.sql"),
    },
    EmbeddedMigration {
        version: 60,
        description: "resumable attachment uploads",
        sql: include_str!("../../../migrations/0060_resumable_attachment_uploads.sql"),
    },
    EmbeddedMigration {
        version: 61,
        description: "canonical generated and uploaded avatars",
        sql: include_str!("../../../migrations/0061_canonical_avatars.sql"),
    },
    EmbeddedMigration {
        version: 62,
        description: "monotonic call revisions",
        sql: include_str!("../../../migrations/0062_call_revisions.sql"),
    },
    EmbeddedMigration {
        version: 63,
        description: "account-scoped default self-agent sessions",
        sql: include_str!(
            "../../../migrations/0063_account_scoped_default_self_agent_sessions.sql"
        ),
    },
    EmbeddedMigration {
        version: 64,
        description: "reference-backed uploaded avatar assets",
        sql: include_str!("../../../migrations/0064_avatar_assets.sql"),
    },
    EmbeddedMigration {
        version: 65,
        description: "repair resumable attachment uploads",
        sql: include_str!("../../../migrations/0065_repair_resumable_attachment_uploads.sql"),
    },
];

/// Every migration, early then recent.
pub(super) static EMBEDDED_MIGRATIONS: LazyLock<Vec<EmbeddedMigration>> =
    LazyLock::new(|| [EARLY_MIGRATIONS, RECENT_MIGRATIONS].concat());
