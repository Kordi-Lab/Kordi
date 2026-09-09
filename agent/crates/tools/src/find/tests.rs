use super::*;

async fn wait_for_pid(path: &Path) -> u32 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(path).await
                && let Ok(pid) = text.trim().parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("search process started")
}

async fn assert_process_exited(pid: u32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            // Signal zero observes process existence without changing it.
            if unsafe { libc::kill(pid as i32, 0) } == -1 {
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::ESRCH)
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("search process must terminate");
}

async fn sleeping_search(path: &Path) -> KordiResult<Output> {
    Ok(search_output(
        Command::new("sh")
            .args(["-c", "echo $$ > \"$1\"; exec sleep 60", "search-test"])
            .arg(path),
    )
    .await?)
}

#[tokio::test]
async fn cancellation_terminates_the_running_search_process() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let search_pid_file = pid_file.clone();
    let cancel = CancellationToken::new();
    let search_cancel = cancel.clone();
    let search = tokio::spawn(async move {
        bounded_search(
            sleeping_search(&search_pid_file),
            search_cancel,
            SEARCH_TIMEOUT,
        )
        .await
    });
    let pid = wait_for_pid(&pid_file).await;
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(2), search)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(KordiError::Aborted)));
    assert_process_exited(pid).await;
}

#[tokio::test]
async fn deadline_terminates_the_running_search_process() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let search_pid_file = pid_file.clone();
    let search = tokio::spawn(async move {
        bounded_search(
            sleeping_search(&search_pid_file),
            CancellationToken::new(),
            Duration::from_secs(1),
        )
        .await
    });
    let pid = wait_for_pid(&pid_file).await;
    let error = search.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("File search timed out"));
    assert_process_exited(pid).await;
}

#[tokio::test]
async fn cancelled_search_does_not_start_a_process() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = bounded_search(sleeping_search(&pid_file), cancel, SEARCH_TIMEOUT).await;
    assert!(matches!(result, Err(KordiError::Aborted)));
    assert!(!pid_file.exists());
}

#[tokio::test]
async fn dropping_the_runtime_terminates_its_search_process() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let search_pid_file = pid_file.clone();
    let search = tokio::spawn(async move { sleeping_search(&search_pid_file).await });
    let pid = wait_for_pid(&pid_file).await;
    search.abort();
    assert!(search.await.unwrap_err().is_cancelled());
    assert_process_exited(pid).await;
}

#[tokio::test]
async fn completed_search_preserves_results() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("example.rs"), "").unwrap();
    let result = bounded_search(
        async {
            find_with_find_cmd("*.rs", directory.path(), 10)
                .await
                .map_err(|error| KordiError::Tool(error.to_string()))
        },
        CancellationToken::new(),
        SEARCH_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(result.len(), 1);
    assert!(result[0].ends_with("example.rs"));
}
