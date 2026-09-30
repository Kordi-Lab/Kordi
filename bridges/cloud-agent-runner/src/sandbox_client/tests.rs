use super::*;
use std::fs;

#[tokio::test]
async fn local_backend_read_bytes_matches_written_content() {
    let root = std::env::temp_dir().join(format!(
        "kordi-sandbox-bytes-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let backend = LocalSandboxBackend::new(root.clone());
    backend.write_text("artifact.txt", "hello").await.unwrap();

    let bytes = backend.read_bytes("artifact.txt").await.unwrap();

    assert_eq!(bytes, b"hello");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn local_commands_do_not_see_the_runner_environment() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let secret_name = format!("KORDI_TEST_RUNNER_SECRET_{suffix}");
    let secret_value = format!("runner-secret-{suffix}");
    std::env::set_var(&secret_name, &secret_value);
    let root = std::env::temp_dir().join(format!("kordi-sandbox-env-{suffix}"));
    let backend = LocalSandboxBackend::new(root.clone());

    let output = backend.run_bash("env").await.unwrap();

    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    assert!(!output.stdout.contains(&secret_value));
    assert!(!output.stdout.contains(&secret_name));
    let names: Vec<&str> = output
        .stdout
        .lines()
        .filter_map(|line| line.split_once('=').map(|(name, _)| name))
        .collect();
    for name in &names {
        assert!(
            matches!(
                *name,
                "PATH" | "HOME" | "LANG" | "TMPDIR" | "PWD" | "OLDPWD" | "SHLVL" | "_"
            ),
            "unexpected variable {name} in sandbox environment"
        );
    }
    let home = format!("HOME={}", root.display());
    let tmpdir = format!("TMPDIR={}", root.join(".tmp").display());
    assert!(output.stdout.lines().any(|line| line == home));
    assert!(output.stdout.lines().any(|line| line == tmpdir));
    assert!(root.join(".tmp").is_dir());

    std::env::remove_var(&secret_name);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn local_commands_still_find_standard_tools() {
    let root = std::env::temp_dir().join(format!(
        "kordi-sandbox-path-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let backend = LocalSandboxBackend::new(root.clone());

    let output = backend
        .run_bash("printf hello > note.txt && cat note.txt")
        .await
        .unwrap();

    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    assert_eq!(output.stdout, "hello");
    let _ = std::fs::remove_dir_all(root);
}

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "kordi-sandbox-{label}-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

fn escapes(result: Result<impl std::fmt::Debug, SandboxClientError>) -> bool {
    matches!(
        result,
        Err(SandboxClientError::BlockedPath(
            RunnerToolBlockReason::PathEscapesSandbox
        ))
    )
}

#[tokio::test]
async fn local_file_tools_never_follow_links_out_of_the_sandbox() {
    let root = test_root("links");
    let outside = test_root("links-outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside secret").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("leak")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("dir")).unwrap();
    let backend = LocalSandboxBackend::new(root.clone());

    assert!(escapes(backend.read_text("leak").await));
    assert!(escapes(backend.read_bytes("leak").await));
    assert!(escapes(backend.read_bytes_bounded("leak", 64).await));
    assert!(escapes(backend.read_text("dir/secret.txt").await));
    assert!(escapes(backend.list("dir").await));
    assert!(escapes(backend.write_text("dir/planted.txt", "x").await));
    assert!(escapes(backend.write_text("leak", "overwritten").await));
    assert!(!outside.join("planted.txt").exists());
    assert_eq!(
        fs::read_to_string(outside.join("secret.txt")).unwrap(),
        "outside secret"
    );

    backend
        .write_text("inside/note.txt", "inside")
        .await
        .unwrap();
    assert_eq!(
        backend.read_text("inside/note.txt").await.unwrap(),
        "inside"
    );
    assert_eq!(backend.list("inside").await.unwrap(), vec!["note.txt"]);
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(outside);
}

#[tokio::test]
async fn local_file_tools_read_only_regular_files() {
    let root = test_root("fifo");
    fs::create_dir_all(&root).unwrap();
    let fifo = std::ffi::CString::new(root.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: `fifo` is a valid NUL-terminated path.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
    let backend = LocalSandboxBackend::new(root.clone());

    // A named pipe without a writer must not block the runner.
    let read = tokio::time::timeout(std::time::Duration::from_secs(5), backend.read_text("pipe"))
        .await
        .expect("reading a named pipe must not block");
    assert!(read.is_err());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn a_root_runner_always_switches_local_commands_to_another_user() {
    assert_eq!(local_sandbox_identity(false, Some("10001"), None), Ok(None));
    let default = Some(SandboxIdentity {
        uid: DEFAULT_LOCAL_SANDBOX_ID,
        gid: DEFAULT_LOCAL_SANDBOX_ID,
    });
    assert_eq!(local_sandbox_identity(true, None, None), Ok(default));
    assert_eq!(
        local_sandbox_identity(true, Some(" "), Some("")),
        Ok(default)
    );
    assert_eq!(
        local_sandbox_identity(true, Some("2000"), Some("3000")),
        Ok(Some(SandboxIdentity {
            uid: 2000,
            gid: 3000
        }))
    );
    for (uid, gid) in [(Some("0"), None), (None, Some("0")), (Some("root"), None)] {
        assert!(
            local_sandbox_identity(true, uid, gid).is_err(),
            "{uid:?} {gid:?}"
        );
    }
}

#[tokio::test]
async fn commands_can_change_files_the_runner_wrote() {
    let root = test_root("owner");
    let backend = LocalSandboxBackend::new(root.clone());
    backend
        .write_text("notes/today.txt", "first")
        .await
        .unwrap();

    let output = backend
        .run_bash("printf ' second' >> notes/today.txt && printf x > notes/new.txt && cat notes/today.txt")
        .await
        .unwrap();

    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    assert_eq!(output.stdout, "first second");
    let _ = fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_root_runner_keeps_its_environment_from_local_commands() {
    if !runner_is_root() {
        eprintln!("skipped: switching users needs a root runner");
        return;
    }
    // The runner can read its own environment, so there is something to
    // protect.
    assert!(!fs::read("/proc/self/environ").unwrap().is_empty());
    let root = test_root("proc");
    let backend = LocalSandboxBackend::new(root.clone());
    let identity = backend.identity().expect("a root runner switches users");

    // `printf '\057proc'` avoids the command filter's absolute-path check,
    // as a determined command would.
    let output = backend
        .run_bash(
            "id -u; p=$(printf '\\057proc'); \
             for pid in $PPID 1; do \
               if cat \"$p/$pid/environ\" > environ.out 2> environ.err; then echo \"$pid readable\"; \
               else echo \"$pid unreadable\"; fi; \
             done",
        )
        .await
        .unwrap();

    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    let lines: Vec<&str> = output.stdout.lines().collect();
    assert_eq!(lines[0], identity.uid.to_string());
    assert!(
        lines
            .iter()
            .skip(1)
            .all(|line| line.ends_with(" unreadable")),
        "{}",
        output.stdout
    );

    // The runner reading its own environment through a planted link is
    // refused as well.
    std::os::unix::fs::symlink("/proc/self/environ", root.join("environ")).unwrap();
    assert!(escapes(backend.read_text("environ").await));
    let _ = fs::remove_dir_all(root);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_root_runner_gives_an_existing_sandbox_to_the_command_user() {
    use std::os::unix::fs::MetadataExt;
    if !runner_is_root() {
        eprintln!("skipped: switching users needs a root runner");
        return;
    }
    let root = test_root("adopt");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("nested/legacy.txt"), "legacy").unwrap();
    std::os::unix::fs::symlink("/etc/hostname", root.join("nested/link")).unwrap();
    let backend = LocalSandboxBackend::new(root.clone());
    let identity = backend.identity().unwrap();

    let output = backend
        .run_bash("printf ' updated' >> nested/legacy.txt && cat nested/legacy.txt")
        .await
        .unwrap();

    assert_eq!(output.exit_code, 0, "{}", output.stderr);
    assert_eq!(output.stdout, "legacy updated");
    assert_eq!(fs::metadata(&root).unwrap().uid(), identity.uid);
    assert_eq!(
        fs::symlink_metadata(root.join("nested/link"))
            .unwrap()
            .uid(),
        identity.uid
    );
    // The link target was not changed.
    assert_eq!(fs::metadata("/etc/hostname").unwrap().uid(), 0);
    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn resolve_path_blocks_escape_attempts() {
    let root = std::env::temp_dir().join(format!(
        "kordi-sandbox-client-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&root).unwrap();
    let backend = LocalSandboxBackend::new(root.clone());

    assert!(backend
        .resolve_path("safe/file.txt")
        .unwrap()
        .starts_with(&root));
    assert!(backend.resolve_path("../outside.txt").is_err());
    assert!(backend.resolve_path("/tmp/outside.txt").is_err());

    let _ = fs::remove_dir_all(root);
}
