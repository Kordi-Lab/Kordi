use super::*;
use kordi_core::types::{EntryBase, EntryId, SessionEntry};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> Fixture {
    let path = std::env::temp_dir().join(format!("kordi-catalog-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    Fixture(std::fs::canonicalize(&path).unwrap())
}

#[test]
fn a_project_folder_under_home_resolves_from_its_catalog_id() {
    let fixture = fixture();
    let home = fixture.0.join("home");
    let root = home.join("example-project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(home.join("Developer").join("example-project")).unwrap();
    let id = catalog_id(&root);
    assert_eq!(
        find_catalog_root(&id, "example-project", &[], Some(&home)),
        Some(root.clone())
    );
    // Another folder with the same name never matches the catalog ID.
    assert_eq!(
        find_catalog_root(&"0".repeat(64), "example-project", &[], Some(&home)),
        None
    );
    // Names that escape the search folders are ignored.
    assert_eq!(
        find_catalog_root(&id, "../home/example-project", &[], Some(&home)),
        None
    );
}

#[test]
fn hints_find_projects_outside_the_common_folders() {
    let fixture = fixture();
    let root = fixture.0.join("work").join("renamed-folder");
    let sibling = fixture.0.join("work").join("other");
    std::fs::create_dir_all(root.join("nested")).unwrap();
    std::fs::create_dir_all(&sibling).unwrap();
    let id = catalog_id(&root);
    let inside = vec![root.join("nested").display().to_string()];
    assert_eq!(
        find_catalog_root(&id, "Display name", &inside, None),
        Some(root.clone())
    );
    let next_to = vec![sibling.display().to_string()];
    assert_eq!(
        find_catalog_root(&id, "renamed-folder", &next_to, None),
        Some(root)
    );
}

#[test]
fn automatic_binding_skips_a_project_archived_on_this_mac() {
    let fixture = fixture();
    let home = fixture.0.join("home");
    let root = home.join("example-project");
    std::fs::create_dir_all(&root).unwrap();
    let database = fixture.0.join("sessions.db");
    let connection = kordi_session::store::open_db(&database).unwrap();
    let id = catalog_id(&root);
    assert_eq!(
        resolve_catalog_project(&database, &id, "example-project", &[], Some(&home)).unwrap(),
        Some(root.clone())
    );
    kordi_session::store::upsert_project(
        &connection,
        &format!("project:{}", root.display()),
        &root.display().to_string(),
        None,
    )
    .unwrap();
    connection
        .execute("UPDATE projects SET archived_at = datetime('now')", [])
        .unwrap();
    assert_eq!(
        resolve_catalog_project(&database, &id, "example-project", &[], Some(&home)).unwrap(),
        None
    );
    assert!(resolve_catalog_project(&database, "not-an-id", "x", &[], Some(&home)).is_err());
}

#[test]
fn a_located_folder_must_match_the_catalog_id() {
    let fixture = fixture();
    let root = fixture.0.join("example-project");
    let other = fixture.0.join("other");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let id = catalog_id(&root);
    assert_eq!(
        located_catalog_root(&id, &root.display().to_string()).unwrap(),
        root
    );
    assert!(located_catalog_root(&id, &other.display().to_string())
        .unwrap_err()
        .contains("not the project's folder"));
    assert!(located_catalog_root(&id, &fixture.0.join("missing").display().to_string()).is_err());
}

fn select_workspace(connection: &rusqlite::Connection, session_id: &str, path: &str) {
    kordi_session::store::append_entry(
        connection,
        session_id,
        &SessionEntry::Custom {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: chrono::Utc::now(),
            },
            custom_type: "desktop_execution_workspace".into(),
            data: Some(serde_json::json!({ "path": path })),
        },
    )
    .unwrap();
}

#[test]
fn only_selected_worktrees_publish_a_workspace_id() {
    let fixture = fixture();
    let database = fixture.0.join("sessions.db");
    let connection = kordi_session::store::open_db(&database).unwrap();
    let root = "/Users/example/example-project";
    let tree = "/Users/example/KordiWorktrees/chat-example";
    for (id, cwd, selected) in [
        ("in-worktree", tree, Some(tree)),
        ("in-root", root, Some(root)),
        ("unconfirmed", tree, None),
    ] {
        kordi_session::store::create_session_with_id(&connection, id, cwd).unwrap();
        kordi_session::store::update_session_scope(&connection, id, "project", cwd, Some(root))
            .unwrap();
        if let Some(path) = selected {
            select_workspace(&connection, id, path);
        }
    }
    kordi_session::store::create_session_with_id(&connection, "plain", tree).unwrap();
    let ids = session_workspace_ids(
        &database,
        &["in-worktree", "in-root", "unconfirmed", "plain", "missing"].map(String::from),
    )
    .unwrap();
    assert_eq!(
        ids,
        HashMap::from([("in-worktree".to_string(), catalog_id(Path::new(tree)))])
    );
}
