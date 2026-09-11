#[tokio::test]
async fn explicit_workdir_runs_on_device_without_asking_the_owner_again() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("My Project");
    fs::create_dir(&project).unwrap();
    fs::write(project.join("fixture.txt"), "local-workspace-fixture").unwrap();
    let mut ctx = make_ctx(root.path());
    ctx.request_approval = None;
    let result = BashTool
        .execute(
            json!({"command":"cat fixture.txt", "workdir":"./My Project", "raw":true}),
            &ctx,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!result.is_error);
    assert!(
        matches!(&result.content[0], ContentBlock::Text { text } if text.contains("local-workspace-fixture"))
    );
    assert_eq!(ctx.cwd, root.path());
    let outside = tempfile::tempdir().unwrap();
    ctx.execution_policy = crate::ExecutionPolicy::Safety;
    assert!(
        BashTool
            .execute(
                json!({"command":"pwd", "workdir":outside.path()}),
                &ctx,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
    ctx.execution_policy = crate::ExecutionPolicy::Shared;
    assert!(
        BashTool
            .execute(
                json!({"command":"pwd", "workdir":"./My Project"}),
                &ctx,
                CancellationToken::new()
            )
            .await
            .is_err()
    );
}
