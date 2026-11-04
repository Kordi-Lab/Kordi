//! The harness itself, driven by the scripted stub model. Grounding builds
//! need no database and run in every CI pass; the System agent fixtures need a
//! local PostgreSQL server, where each test creates and drops its own
//! database, and run where CI provides one.

use kordi_system_agent_eval::database::DisposableDatabase;
use kordi_system_agent_eval::fixture::{self, Fixture};
use kordi_system_agent_eval::replay::Engine;
use kordi_system_agent_eval::report::RunReport;
use kordi_system_agent_eval::setup;
use serde_json::json;

fn fixtures(kind: &str) -> Vec<Fixture> {
    fixture::load_dir(
        &kordi_system_agent_eval::default_fixture_dir(),
        chrono::Utc::now(),
    )
    .unwrap()
    .into_iter()
    .filter(|fixture| fixture.kind() == kind)
    .collect()
}

fn failures(report: &RunReport) -> Vec<String> {
    report
        .fixtures
        .iter()
        .flat_map(|fixture| {
            fixture
                .passes
                .iter()
                .enumerate()
                .flat_map(move |(index, pass)| {
                    pass.checks
                        .iter()
                        .filter(|check| !check.passed)
                        .map(move |check| {
                            format!(
                                "{} / pass {} / {}: {}",
                                fixture.id,
                                index + 1,
                                check.name,
                                check.detail.clone().unwrap_or_default()
                            )
                        })
                })
        })
        .collect()
}

#[tokio::test]
async fn grounding_fixtures_pass_with_the_stub_model() {
    let settings = setup::stub_settings();
    let config = settings.pending.unprovisioned();
    let fixtures = fixtures("grounding");
    let report = setup::run_suite(
        "stub",
        &fixtures,
        &config,
        None,
        Engine::Stub,
        None,
        chrono::Utc::now(),
    )
    .await
    .unwrap();
    assert_eq!(failures(&report), Vec::<String>::new());
    assert_eq!(report.summary.fixtures.passed, fixtures.len());
    assert!(report.summary.metrics["grounding"].total >= 8);
}

fn server_url() -> String {
    std::env::var(setup::DATABASE_URL_VAR).expect("database URL")
}

/// Replays `fixtures` with the stub model into a new database, which is
/// dropped before the caller asserts anything.
async fn replay_with_stub(label: &str, fixtures: &[Fixture]) -> RunReport {
    let database = DisposableDatabase::prepare(&server_url())
        .await
        .expect("quality test server");
    let settings = setup::stub_settings();
    let result = async {
        let pool = database.create().await?;
        let harness = setup::harness(pool, settings.pending, Engine::Stub).await?;
        setup::run_suite(
            label,
            fixtures,
            &harness.config,
            Some(&harness),
            Engine::Stub,
            None,
            chrono::Utc::now(),
        )
        .await
    }
    .await;
    assert!(database.drop_database().await, "dropping the database");
    result.unwrap()
}

async fn database_exists(admin: &sqlx_postgres::PgPool, name: &str) -> bool {
    sqlx_core::query_scalar::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)",
    )
    .bind(name)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a local PostgreSQL server in KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL"]
async fn each_run_gets_its_own_database_and_drops_it() {
    let url = server_url();
    let admin = sqlx_postgres::PgPool::connect(&url).await.unwrap();
    let database = DisposableDatabase::prepare(&url).await.unwrap();
    let name = database.name().to_string();
    assert!(name.starts_with("kordi_eval_"), "{name}");
    assert!(
        !database_exists(&admin, &name).await,
        "prepare creates nothing"
    );
    let pool = database.create().await.unwrap();
    assert!(database_exists(&admin, &name).await);
    let (current, migrated): (String, i64) = sqlx_core::query_as::query_as(
        "SELECT current_database(), (SELECT count(*) FROM cloud_schema_versions)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(current, name);
    assert!(migrated > 0);
    // The named database is only an administration connection.
    let touched: bool = sqlx_core::query_scalar::query_scalar(
        "SELECT to_regclass('cloud_schema_versions') IS NOT NULL",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(!touched, "the server URL's own database was migrated");
    // The run's pool is closed first; dropping twice is harmless.
    let again = database.clone();
    assert!(database.drop_database().await);
    assert!(pool.is_closed());
    assert!(!database_exists(&admin, &name).await);
    // A database that was never created drops cleanly too.
    let never = DisposableDatabase::prepare(&url).await.unwrap();
    assert!(never.drop_database().await);
    drop(again);
    admin.close().await;
}

#[tokio::test]
#[ignore = "requires a local PostgreSQL server in KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL"]
async fn system_agent_fixtures_pass_with_the_stub_model() {
    let fixtures = fixtures("systemAgent");
    let report = replay_with_stub("stub", &fixtures).await;
    assert_eq!(failures(&report), Vec::<String>::new());
    let summary = &report.summary;
    assert_eq!(summary.fixtures.passed, fixtures.len());
    // The sweep's free check skips small talk, messages for other agents and
    // a reminder that already went out.
    assert_eq!(summary.skipped_by_sweep, 3, "{summary:?}");
    for metric in [
        "planCard",
        "silence",
        "reply",
        "toolValidity",
        "repetition",
        "reliability",
        "sweep",
    ] {
        assert!(
            summary.metrics[metric].total > 0,
            "{metric} was never checked"
        );
    }
}

fn set_stub(fixtures: &mut [Fixture], id: &str, turn: usize, stub: serde_json::Value) {
    for fixture in fixtures {
        if let Fixture::SystemAgent(conversation) = fixture {
            if conversation.id == id {
                conversation.turns[turn].stub = serde_json::from_value(stub).unwrap();
                return;
            }
        }
    }
    panic!("no fixture {id}");
}

#[tokio::test]
#[ignore = "requires a local PostgreSQL server in KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL"]
async fn scoring_catches_a_model_that_misbehaves() {
    let mut fixtures: Vec<Fixture> = fixtures("systemAgent")
        .into_iter()
        .filter(|fixture| {
            [
                "silent-past-recap",
                "repeat-temptation",
                "organizer-cancels",
                "reschedule-confirmed-plan",
            ]
            .contains(&fixture.id())
        })
        .collect();
    let speak = |text: &str| json!([{"final": {"message": text, "hooksHandled": []}}]);
    set_stub(
        &mut fixtures,
        "silent-past-recap",
        0,
        speak("Want me to plan another dinner?"),
    );
    set_stub(
        &mut fixtures,
        "repeat-temptation",
        0,
        speak(
            "Two days are on the table, so I opened a vote. Vote on the card so we can lock it in.",
        ),
    );
    set_stub(
        &mut fixtures,
        "organizer-cancels",
        0,
        json!([
            {"toolCalls": [{"action": "cancel", "eventId": "$eventId", "revision": 999,
                "canceledBy": "$member:maya"}]},
            {"final": {"message": "Canceled.", "hooksHandled": []}}
        ]),
    );
    // A second card instead of revising the confirmed one.
    set_stub(
        &mut fixtures,
        "reschedule-confirmed-plan",
        0,
        json!([
            {"toolCalls": [{"action": "propose", "conversationId": "$conversationId",
                "title": "Dinner at Luigi's", "state": "awaitingConfirmation",
                "participants": "$participants:maya", "sourceMessageIds": "$newMessageIds"}]},
            {"final": {"message": null, "hooksHandled": []}}
        ]),
    );
    let report = replay_with_stub("misbehaving", &fixtures).await;
    let failed = failures(&report);
    let has = |needle: &str| failed.iter().any(|failure| failure.contains(needle));
    assert!(
        has("silent-past-recap / pass 1 / stays silent"),
        "{failed:#?}"
    );
    assert!(
        has("repeat-temptation / pass 1 / does not repeat an earlier message"),
        "{failed:#?}"
    );
    assert!(
        has("organizer-cancels / pass 1 / plan_card cancel is expected and accepted"),
        "{failed:#?}"
    );
    assert!(
        has("organizer-cancels / pass 1 / uses plan_card cancel"),
        "{failed:#?}"
    );
    assert!(
        has("reschedule-confirmed-plan / pass 1 / starts at"),
        "{failed:#?}"
    );
    assert_eq!(report.summary.fixtures.passed, 0);
}
