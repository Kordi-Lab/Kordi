use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::tests::{EchoTool, NoEvents, request};
use crate::{OmpRuntime, RuntimeError, WorkerCommand};

const TURN: &str = r#"echo $$ >> "$DIR/spawned"
read request
echo $$ >> "$DIR/ran"
printf '%s\n' '{"type":"ready","schemaVersion":1}'
printf '%s\n' '{"type":"result","schemaVersion":1,"runId":"run-1","attemptId":"attempt-1","sequence":1,"text":"done"}'
"#;

fn temp_dir() -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "kordi-omp-warm-{}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&dir).unwrap();
    dir
}

/// The worker environment is cleared, so the directory is baked into the script.
fn command(dir: &Path, prefix: &str) -> WorkerCommand {
    let script = format!("DIR='{}'\n{prefix}{TURN}", dir.display());
    WorkerCommand {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        computer_lock_path: None,
    }
}

fn pids(dir: &Path, name: &str) -> Vec<u32> {
    std::fs::read_to_string(dir.join(name))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..250 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

/// A reaped or zombie process no longer runs.
fn gone(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&output.stdout);
    stat.trim().is_empty() || stat.trim_start().starts_with('Z')
}

async fn turn(runtime: &OmpRuntime) -> Result<String, RuntimeError> {
    runtime
        .run_turn(&request(), &EchoTool, &NoEvents, CancellationToken::new())
        .await
        .map(|result| result.text)
}

#[tokio::test]
async fn warm_worker_serves_first_turn_and_is_replaced_for_the_next() {
    let dir = temp_dir();
    let runtime = OmpRuntime::new(command(&dir, "")).with_warm_workers(1);
    runtime.prewarm();
    wait_until("warm worker", || pids(&dir, "spawned").len() == 1).await;
    assert!(
        pids(&dir, "ran").is_empty(),
        "warm worker ran before its turn"
    );

    assert_eq!(turn(&runtime).await.unwrap(), "done");
    assert_eq!(pids(&dir, "ran"), pids(&dir, "spawned")[..1]);
    wait_until("replacement", || pids(&dir, "spawned").len() == 2).await;

    assert_eq!(turn(&runtime.clone()).await.unwrap(), "done");
    let spawned = pids(&dir, "spawned");
    assert_eq!(pids(&dir, "ran"), spawned[..2]);
    wait_until("second replacement", || pids(&dir, "spawned").len() == 3).await;

    let idle = pids(&dir, "spawned")[2];
    runtime.shutdown();
    wait_until("idle worker killed on shutdown", || gone(idle)).await;
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn dead_warm_worker_is_replaced_and_turn_succeeds() {
    let dir = temp_dir();
    let crash = "if [ ! -e \"$DIR/died\" ]; then echo $$ > \"$DIR/died\"; exit 3; fi\n";
    let runtime = OmpRuntime::new(command(&dir, crash)).with_warm_workers(1);
    runtime.prewarm();
    wait_until("crashed warm worker", || {
        pids(&dir, "died").first().is_some_and(|pid| gone(*pid))
    })
    .await;

    assert_eq!(turn(&runtime).await.unwrap(), "done");
    let died = pids(&dir, "died")[0];
    assert!(!pids(&dir, "ran").contains(&died));
    wait_until("replacement", || {
        runtime.warm.as_ref().unwrap().idle_len() == 1 && pids(&dir, "spawned").len() == 2
    })
    .await;
    drop(runtime);
    let idle = pids(&dir, "spawned")[1];
    wait_until("idle worker killed on drop", || gone(idle)).await;
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn warm_worker_that_closed_stdin_falls_back_to_fresh_spawn() {
    let dir = temp_dir();
    // Alive for the liveness check, but the Run write hits a closed pipe.
    let broken =
        "if [ ! -e \"$DIR/broken\" ]; then echo $$ > \"$DIR/broken\"; exec 0<&-; sleep 30; fi\n";
    let runtime = OmpRuntime::new(command(&dir, broken)).with_warm_workers(1);
    runtime.prewarm();
    wait_until("broken warm worker", || !pids(&dir, "broken").is_empty()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(turn(&runtime).await.unwrap(), "done");
    let broken = pids(&dir, "broken")[0];
    assert!(!pids(&dir, "ran").contains(&broken));
    wait_until("broken worker killed", || gone(broken)).await;
    runtime.shutdown();
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn disabled_warm_pool_spawns_only_on_demand() {
    let dir = temp_dir();
    let runtime = OmpRuntime::new(command(&dir, ""));
    assert!(runtime.warm.is_none());
    runtime.prewarm();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(pids(&dir, "spawned").is_empty());

    assert_eq!(turn(&runtime).await.unwrap(), "done");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(pids(&dir, "spawned").len(), 1);
    assert_eq!(pids(&dir, "ran"), pids(&dir, "spawned"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn cancelled_turn_kills_taken_warm_worker_and_drop_kills_idle_one() {
    let dir = temp_dir();
    let runtime = OmpRuntime::new(command(&dir, "")).with_warm_workers(1);
    runtime.prewarm();
    wait_until("warm worker", || pids(&dir, "spawned").len() == 1).await;
    let taken = pids(&dir, "spawned")[0];

    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = runtime
        .run_turn(&request(), &EchoTool, &NoEvents, cancel)
        .await;
    assert!(matches!(result, Err(RuntimeError::Cancelled)));
    wait_until("cancelled worker killed", || gone(taken)).await;
    assert!(pids(&dir, "ran").len() <= 1);

    wait_until("replacement", || pids(&dir, "spawned").len() == 2).await;
    let idle = pids(&dir, "spawned")[1];
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(runtime);
    wait_until("idle worker killed on drop", || gone(idle)).await;
    std::fs::remove_dir_all(&dir).unwrap();
}
