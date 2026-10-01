use super::*;

#[test]
fn worktree_parser_preserves_spaces_and_detached_head() {
    let trees = parse_worktrees("worktree /fixture/main project\0HEAD abcd\0branch refs/heads/main\0\0worktree /fixture/detached\0HEAD abcd\0detached\0\0");
    assert_eq!(trees.len(), 2);
    assert_eq!(trees[0].path, "/fixture/main project");
    assert_eq!(trees[0].branch.as_deref(), Some("main"));
    assert!(trees[1].branch.is_none());
}

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn chat_worktree_preserves_the_original_checkout_and_rejects_other_folders(
) -> Result<(), String> {
    let fixture =
        Fixture(std::env::temp_dir().join(format!("kordi-git-test-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&fixture.0).map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(&fixture.0).map_err(|e| e.to_string())?;
    git(&root, &["init", "-b", "main"]).await?;
    git(
        &root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "Synthetic initial commit",
        ],
    )
    .await?;
    std::fs::write(root.join("draft.txt"), "Uncommitted owner work").map_err(|e| e.to_string())?;
    let parent = root.join("worktrees");
    let tree = create_worktree(&root, "fixture-session", None, &parent).await?;
    assert_eq!(
        text(git(&root, &["symbolic-ref", "--short", "HEAD"]).await?)?.trim(),
        "main"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("draft.txt")).unwrap(),
        "Uncommitted owner work"
    );
    assert!(!tree.join("draft.txt").exists());
    std::fs::write(tree.join("chat-work.txt"), "Worktree edits").map_err(|e| e.to_string())?;
    assert_eq!(
        create_worktree(&root, "fixture-session", None, &parent).await?,
        tree
    );
    assert!(tree.join("chat-work.txt").exists());
    let selection = |path: &Path| {
        Some(ChatWorkspaceSelection {
            worktree: None,
            branch: None,
            workspace_root: Some(path.display().to_string()),
        })
    };
    assert_eq!(
        select_workspace(&root, "fixture-session", selection(&tree)).await?,
        tree
    );
    assert!(
        select_workspace(&root, "fixture-session", selection(&parent))
            .await
            .is_err()
    );
    assert!(select_workspace(
        &root,
        "fixture-session",
        Some(ChatWorkspaceSelection {
            worktree: Some(true),
            branch: Some("missing-branch".into()),
            workspace_root: None
        })
    )
    .await
    .is_err());
    assert_eq!(
        select_workspace(
            &root,
            "fixture-session",
            Some(ChatWorkspaceSelection {
                worktree: Some(false),
                branch: None,
                workspace_root: None
            })
        )
        .await?,
        root
    );
    assert!(tree.join("chat-work.txt").exists());
    Ok(())
}
