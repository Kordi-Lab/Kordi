use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;

use super::*;
use crate::resource_pools::{test_provider, PoolLimits, ResourcePool};

fn at(day: u32, hour: u32, minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2030, 1, day, hour, minute, 0).unwrap()
}

fn capped(cost: u64) -> ResourcePool {
    ResourcePool::new(
        "capped",
        test_provider("synthetic-model").with_estimated_cost_micros(cost),
    )
    .with_limits(PoolLimits {
        system_agent_runs_per_conversation: Some(10),
        grounding_runs_per_person: Some(4),
        pool_runs: Some(200),
        pool_spend_micros: Some(1_000_000),
    })
}

fn conversation(runs: u64) -> Option<Scoped> {
    Some(Scoped {
        feature: Feature::SystemAgent,
        counter: Counter {
            runs,
            spend_micros: 0,
        },
    })
}

fn by_id<'a>(snapshots: &'a [UsageSnapshot], id: &str) -> &'a UsageSnapshot {
    snapshots
        .iter()
        .find(|snapshot| snapshot.limit_id == id)
        .unwrap_or_else(|| panic!("no snapshot {id}"))
}

#[test]
fn percentages_round_down_and_cap_at_one_hundred() {
    assert_eq!(used_percent(0, 10), 0);
    assert_eq!(used_percent(3, 4), 75);
    assert_eq!(used_percent(899, 1000), 89);
    assert_eq!(used_percent(9, 10), 90);
    assert_eq!(used_percent(12, 10), 100);
    assert_eq!(used_percent(0, 0), 100);
    assert_eq!(used_percent(u64::MAX, u64::MAX), 100);
    assert_eq!(used_percent(u64::MAX / 2, u64::MAX), 49);
}

#[test]
fn one_snapshot_per_limited_counter() {
    let now = at(2, 15, 30);
    let snapshots = build(
        &capped(10_000),
        conversation(7),
        Counter {
            runs: 150,
            spend_micros: 400_000,
        },
        now,
    );
    let ids: Vec<_> = snapshots.iter().map(|s| s.limit_id).collect();
    assert_eq!(
        ids,
        ["conversation.system_agent_runs", "pool.runs", "pool.spend"]
    );
    let chat = by_id(&snapshots, "conversation.system_agent_runs");
    assert_eq!(
        (chat.scope, chat.used, chat.limit, chat.used_percent),
        (Scope::Conversation, Some(7), Some(10), 70)
    );
    assert_eq!(chat.reached, Reached::None);
    assert_eq!(chat.window, "day");
    assert_eq!(chat.resets_at, "2030-01-03T00:00:00Z");
    assert_eq!(by_id(&snapshots, "pool.runs").used_percent, 75);
    assert_eq!(by_id(&snapshots, "pool.spend").used_percent, 40);
}

#[test]
fn unlimited_limits_are_left_out() {
    let pool = ResourcePool::new("open", test_provider("synthetic-model"));
    assert!(build(&pool, conversation(99), Counter::default(), at(2, 1, 0)).is_empty());
    let runs_only =
        ResourcePool::new("runs", test_provider("synthetic-model")).with_limits(PoolLimits {
            pool_runs: Some(5),
            ..PoolLimits::default()
        });
    let snapshots = build(&runs_only, conversation(1), Counter::default(), at(2, 1, 0));
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].limit_id, "pool.runs");
}

#[test]
fn reached_limits_name_their_reason() {
    let now = at(2, 9, 0);
    let pool = capped(10_000);
    // The conversation's own cap.
    let snapshots = build(&pool, conversation(10), Counter::default(), now);
    assert_eq!(
        by_id(&snapshots, "conversation.system_agent_runs").reached,
        Reached::DailyLimit
    );
    assert_eq!(first_reached(&snapshots), Reached::DailyLimit);
    // The pool's run cap.
    let full = Counter {
        runs: 200,
        spend_micros: 0,
    };
    let snapshots = build(&pool, conversation(1), full, now);
    assert_eq!(by_id(&snapshots, "pool.runs").reached, Reached::DailyLimit);
    // The spend ceiling is reached once the next run's cost cannot fit,
    // although less than all of it is spent.
    let almost = Counter {
        runs: 10,
        spend_micros: 995_000,
    };
    let snapshots = build(&pool, conversation(1), almost, now);
    let spend = by_id(&snapshots, "pool.spend");
    assert_eq!(
        (spend.used_percent, spend.reached),
        (99, Reached::SpendLimit)
    );
    assert_eq!(first_reached(&snapshots), Reached::SpendLimit);
    let fits = Counter {
        runs: 10,
        spend_micros: 990_000,
    };
    assert_eq!(
        first_reached(&build(&pool, conversation(1), fits, now)),
        Reached::None
    );
}

#[test]
fn the_stop_switch_marks_every_limit_stopped() {
    let now = at(2, 9, 0);
    let stopped = capped(0).stopped(true);
    let snapshots = build(&stopped, conversation(0), Counter::default(), now);
    assert_eq!(snapshots.len(), 3);
    assert!(snapshots.iter().all(|s| s.reached == Reached::Stopped));
    assert_eq!(first_reached(&snapshots), Reached::Stopped);

    // A stopped pool without limits still says why it is quiet.
    let open = ResourcePool::new("open", test_provider("synthetic-model")).stopped(true);
    let snapshots = build(&open, conversation(0), Counter::default(), now);
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].limit_id, "pool.stopped");
    assert_eq!(snapshots[0].reached, Reached::Stopped);
    assert_eq!((snapshots[0].used, snapshots[0].limit), (None, None));
}

#[test]
fn the_window_rolls_over_at_utc_midnight() {
    assert_eq!(resets_at(at(2, 0, 0)), at(3, 0, 0));
    assert_eq!(resets_at(at(2, 23, 59)), at(3, 0, 0));
    let last_minute = Utc.with_ymd_and_hms(2030, 1, 2, 23, 59, 59).unwrap();
    assert_eq!(resets_at(last_minute), at(3, 0, 0));
    // Month and year ends.
    let new_year = Utc.with_ymd_and_hms(2030, 12, 31, 18, 0, 0).unwrap();
    assert_eq!(
        resets_at(new_year),
        Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap()
    );
    // A new day reads new, empty counters: the same pool shows nothing used.
    let pool = capped(0);
    let yesterday = build(
        &pool,
        conversation(10),
        Counter {
            runs: 200,
            spend_micros: 0,
        },
        at(2, 23, 0),
    );
    assert_eq!(first_reached(&yesterday), Reached::DailyLimit);
    let today = build(&pool, conversation(0), Counter::default(), at(3, 0, 1));
    assert_eq!(first_reached(&today), Reached::None);
    assert!(today.iter().all(|s| s.used_percent == 0));
    assert!(today.iter().all(|s| s.resets_at == "2030-01-04T00:00:00Z"));
}

#[test]
fn members_never_see_amounts() {
    let snapshots = build(
        &capped(10_000),
        conversation(7),
        Counter {
            runs: 150,
            spend_micros: 400_000,
        },
        at(2, 9, 0),
    );
    for role in [Some(OrganizationRole::Owner), Some(OrganizationRole::Admin)] {
        let seen = for_role(snapshots.clone(), role);
        assert_eq!(seen, snapshots);
        assert_eq!(by_id(&seen, "pool.spend").used, Some(400_000));
    }
    for role in [Some(OrganizationRole::Member), None] {
        let seen = for_role(snapshots.clone(), role);
        assert_eq!(seen.len(), snapshots.len());
        let json = serde_json::to_value(&seen).unwrap();
        for snapshot in json.as_array().unwrap() {
            let mut fields: Vec<&str> = snapshot
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            fields.sort_unstable();
            assert_eq!(
                fields,
                [
                    "limitId",
                    "reached",
                    "resetsAt",
                    "scope",
                    "usedPercent",
                    "window"
                ],
                "a member sees percentages, reasons and reset times only"
            );
        }
        let spend = json
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["limitId"] == "pool.spend")
            .unwrap();
        assert_eq!(spend["usedPercent"], Value::from(40));
    }
}

#[test]
fn snapshots_serialize_in_the_documented_shape() {
    let snapshots = build(
        &capped(0),
        conversation(10),
        Counter::default(),
        at(2, 9, 0),
    );
    let json = serde_json::to_value(&snapshots[0]).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "limitId": "conversation.system_agent_runs",
            "scope": "conversation",
            "used": 10,
            "limit": 10,
            "usedPercent": 100,
            "window": "day",
            "resetsAt": "2030-01-03T00:00:00Z",
            "reached": "daily_limit",
        })
    );
}

#[test]
fn grounding_is_counted_per_account() {
    let scoped = Some(Scoped {
        feature: Feature::Grounding,
        counter: Counter {
            runs: 3,
            spend_micros: 0,
        },
    });
    let snapshots = build(&capped(0), scoped, Counter::default(), at(2, 9, 0));
    let account = by_id(&snapshots, "account.grounding_runs");
    assert_eq!((account.scope, account.used_percent), (Scope::Account, 75));
}
