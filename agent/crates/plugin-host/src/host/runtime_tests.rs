use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use super::PluginHost;
use super::types::{HOST_JS, PluginHostError};

// Separate test processes share one temporary root, just as concurrent CLI clients do.
// The release files hold both hosts alive without relying on a scheduler race.
struct Worker {
    child: Child,
    release: PathBuf,
}

impl Worker {
    fn spawn(root: &Path, name: &str) -> Self {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "host::runtime_tests::runtime_process_worker",
                "--ignored",
            ])
            .env("KORDI_RUNTIME_TEST_ROOT", root)
            .env("KORDI_RUNTIME_TEST_WORKER", name)
            .env("TMPDIR", root)
            .env("TMP", root)
            .env("TEMP", root);
        if name == "spawn-failure" {
            command.env("PATH", "");
        }
        let child = command.spawn().unwrap();
        Self {
            child,
            release: root.join(format!("{name}.release")),
        }
    }

    fn finish(&mut self) {
        std::fs::write(&self.release, "release").unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "runtime worker failed");
                return;
            }
            assert!(Instant::now() < deadline, "runtime worker did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // Release even after an assertion failure so the worker drops its Node host.
        let _ = std::fs::write(&self.release, "release");
        let deadline = Instant::now() + Duration::from_secs(20);
        while matches!(self.child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "runtime worker did not signal readiness"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn concurrent_processes_own_and_clean_up_their_runtime_scripts() {
    let root = tempfile::tempdir().unwrap();
    let mut first = Worker::spawn(root.path(), "drop");
    wait_for_file(&root.path().join("drop.ready"));
    let mut second = Worker::spawn(root.path(), "kill");
    wait_for_file(&root.path().join("kill.ready"));
    let first_script =
        PathBuf::from(std::fs::read_to_string(root.path().join("drop.path")).unwrap());
    let second_script =
        PathBuf::from(std::fs::read_to_string(root.path().join("kill.path")).unwrap());

    assert!(
        first_script != second_script,
        "concurrent hosts shared a runtime path"
    );
    assert_eq!(std::fs::read_to_string(&first_script).unwrap(), HOST_JS);
    assert_eq!(std::fs::read_to_string(&second_script).unwrap(), HOST_JS);
    first.finish();
    assert!(
        !first_script.parent().unwrap().exists(),
        "drop leaked its runtime directory"
    );
    assert!(
        second_script.exists(),
        "dropping one host removed another host's script"
    );
    second.finish();
    assert!(
        !second_script.parent().unwrap().exists(),
        "kill leaked its runtime directory"
    );
}

#[tokio::test]
#[ignore = "subprocess helper for runtime ownership tests"]
async fn runtime_process_worker() {
    let root = PathBuf::from(std::env::var_os("KORDI_RUNTIME_TEST_ROOT").unwrap());
    let name = std::env::var("KORDI_RUNTIME_TEST_WORKER").unwrap();
    if name == "spawn-failure" {
        assert!(matches!(
            PluginHost::load_plugins(&[root.join("unused.js")]).await,
            Err(PluginHostError::SpawnFailed(_))
        ));
        assert!(
            std::fs::read_dir(&root)
                .unwrap()
                .all(|entry| !entry.unwrap().path().is_dir()),
            "spawn failure leaked its runtime directory"
        );
        return;
    }
    let plugin = root.join(format!("{name}.js"));
    std::fs::write(
        &plugin,
        r#"
        module.exports = kordi => kordi.registerCommand('runtime-path', {
          description: 'Return the runtime script path',
          handler: async () => ({ message: process.argv[1] })
        });
    "#,
    )
    .unwrap();
    let mut host = PluginHost::load_plugins(&[plugin]).await.unwrap();
    let result = host.execute_command("runtime-path", "").await.unwrap();
    let script = result["message"].as_str().unwrap();
    std::fs::write(root.join(format!("{name}.path")), script).unwrap();
    std::fs::write(root.join(format!("{name}.ready")), "ready").unwrap();
    wait_for_file(&root.join(format!("{name}.release")));
    // The surviving host must remain usable after the other process tears down.
    let result = host.execute_command("runtime-path", "").await.unwrap();
    assert_eq!(result["message"], script);
    if name == "kill" {
        host.kill().await;
        assert!(
            !Path::new(script).exists(),
            "kill did not clean up before returning"
        );
    }
}

#[test]
fn spawn_failure_cleans_up_the_runtime_script() {
    let root = tempfile::tempdir().unwrap();
    Worker::spawn(root.path(), "spawn-failure").finish();
}

#[tokio::test]
async fn startup_failure_cleans_up_the_runtime_script() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("runtime-path");
    let plugin = root.path().join("exit.js");
    std::fs::write(
        &plugin,
        format!(
            "require('node:fs').writeFileSync({}, process.argv[1]); process.exit(0);",
            serde_json::to_string(&marker).unwrap()
        ),
    )
    .unwrap();
    assert!(matches!(
        PluginHost::load_plugins(&[plugin]).await,
        Err(PluginHostError::ProcessExited)
    ));
    let script = PathBuf::from(std::fs::read_to_string(marker).unwrap());
    assert!(
        !script.parent().unwrap().exists(),
        "startup failure leaked its runtime directory"
    );
}
