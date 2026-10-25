//! An empty working folder of its own for each approved proactive run.
//!
//! The web view only names the run. The path is built here, under a dedicated
//! parent in this user's temporary folder, so a turn can never be pointed at
//! another folder. The parent lies outside the home folder, so no project
//! settings above it apply, and a session resumed after a restart finds its
//! folder at the same path again. The run's prompt loads no instruction file
//! wherever its folder is (`DesktopRuntimeSession::create_proactive_run`).

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const PARENT_DIR: &str = "kordi-proactive-runs";
const RUN_ID_PREFIX: &str = "proactive_run_";
const MAX_RUN_ID_LEN: usize = 128;
/// Leftover folders older than this are removed when a new run starts.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

/// The working folder a shared turn asks for.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkingFolderRequest {
    /// An empty folder of the approved proactive run's own.
    ProactiveRun {
        #[serde(rename = "runId")]
        run_id: String,
    },
}

/// A run's folder. Dropping it removes the folder, whether the turn
/// succeeded, failed or never started.
#[derive(Debug)]
pub(crate) struct RunFolder {
    path: PathBuf,
}

impl RunFolder {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for RunFolder {
    fn drop(&mut self) {
        match remove_entry(&self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                eprintln!("Unable to remove a proactive run folder: {error}");
            }
            _ => {}
        }
    }
}

/// Creates the folder `request` names for the shared turn of `request_id`.
/// A run may only ask for its own folder.
pub(crate) fn create_for_turn(
    request: &WorkingFolderRequest,
    request_id: Option<&str>,
) -> Result<RunFolder, String> {
    let WorkingFolderRequest::ProactiveRun { run_id } = request;
    if request_id.map(str::trim) != Some(run_id.as_str()) {
        return Err("A proactive run folder belongs to that run's own request".to_string());
    }
    create_in(
        &std::env::temp_dir().join(PARENT_DIR),
        run_id,
        SystemTime::now(),
    )
}

fn create_in(parent: &Path, run_id: &str, now: SystemTime) -> Result<RunFolder, String> {
    if !is_valid_run_id(run_id) {
        return Err("The proactive run id is invalid".to_string());
    }
    let prepare = || -> io::Result<RunFolder> {
        ensure_private_parent(parent)?;
        prune_stale(parent, run_id, now);
        let path = parent.join(run_id);
        match remove_entry(&path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        create_private_dir(&path, false)?;
        Ok(RunFolder { path })
    };
    prepare().map_err(|error| format!("Unable to prepare the proactive run folder: {error}"))
}

fn is_valid_run_id(run_id: &str) -> bool {
    run_id.len() <= MAX_RUN_ID_LEN
        && run_id
            .strip_prefix(RUN_ID_PREFIX)
            .is_some_and(|rest| !rest.is_empty())
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The parent must be a real folder only this user can reach, never a link.
fn ensure_private_parent(parent: &Path) -> io::Result<()> {
    if let Err(error) = std::fs::symlink_metadata(parent) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
        create_private_dir(parent, true)?;
    }
    let metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.file_type().is_dir() {
        return Err(io::Error::other("the runs folder is not a folder"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::other("the runs folder is open to other users"));
        }
    }
    Ok(())
}

fn create_private_dir(path: &Path, recursive: bool) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// Removes leftover entries of the parent older than [`STALE_AFTER`].
fn prune_stale(parent: &Path, keep: &str, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name() == keep {
            continue;
        }
        let path = entry.path();
        let stale = std::fs::symlink_metadata(&path)
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| {
                now.duration_since(modified)
                    .is_ok_and(|age| age >= STALE_AFTER)
            });
        if stale {
            let _ = remove_entry(&path);
        }
    }
}

/// Removes `path` without following links: a link is removed, never its
/// target, and `remove_dir_all` does not follow links inside a folder.
fn remove_entry(path: &Path) -> io::Result<()> {
    if std::fs::symlink_metadata(path)?.file_type().is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "kordi-run-folder-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn parent(&self) -> PathBuf {
            self.0.join(PARENT_DIR)
        }

        /// The parent as a run would leave it: a private folder.
        fn private_parent(&self) -> PathBuf {
            let parent = self.parent();
            create_private_dir(&parent, true).unwrap();
            parent
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn is_empty_dir(path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
            && std::fs::read_dir(path).unwrap().next().is_none()
    }

    fn set_modified(path: &Path, time: SystemTime) {
        std::fs::File::open(path)
            .unwrap()
            .set_modified(time)
            .unwrap();
    }

    #[test]
    fn a_run_gets_an_empty_folder_under_the_dedicated_parent_until_dropped() {
        let scratch = Scratch::new();
        let folder =
            create_in(&scratch.parent(), "proactive_run_pro_1", SystemTime::now()).unwrap();
        assert_eq!(folder.path(), scratch.parent().join("proactive_run_pro_1"));
        assert!(is_empty_dir(folder.path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&scratch.parent()), 0o700);
            assert_eq!(mode(folder.path()), 0o700);
        }
        std::fs::write(folder.path().join("notes.txt"), "work").unwrap();
        let path = folder.path().to_path_buf();
        drop(folder);
        assert!(!path.exists());
        assert!(is_empty_dir(&scratch.parent()));
    }

    #[test]
    fn a_folder_is_only_made_for_a_valid_id_of_the_turns_own_request() {
        let scratch = Scratch::new();
        let too_long = format!("proactive_run_{}", "a".repeat(MAX_RUN_ID_LEN));
        for run_id in [
            "",
            "proactive_run_",
            "run_1",
            "proactive_eval_1",
            "x_proactive_run_1",
            "proactive_run_../x",
            "proactive_run_a/b",
            "proactive_run_a b",
            "proactive_run_a.b",
            "proactive_run_\u{e9}",
            too_long.as_str(),
        ] {
            assert!(
                create_in(&scratch.parent(), run_id, SystemTime::now()).is_err(),
                "{run_id:?} must be refused"
            );
        }
        assert!(!scratch.parent().exists(), "a refused id creates nothing");

        let request = WorkingFolderRequest::ProactiveRun {
            run_id: "proactive_run_pro_1".to_string(),
        };
        assert!(create_for_turn(&request, None).is_err());
        assert!(create_for_turn(&request, Some("proactive_run_pro_2")).is_err());
        let parsed: WorkingFolderRequest = serde_json::from_value(
            serde_json::json!({"kind": "proactiveRun", "runId": "proactive_run_pro_1"}),
        )
        .unwrap();
        assert_eq!(parsed, request);
        assert!(serde_json::from_value::<WorkingFolderRequest>(
            serde_json::json!({"kind": "path", "path": "/"})
        )
        .is_err());
    }

    #[test]
    fn an_existing_folder_of_the_run_is_emptied() {
        let scratch = Scratch::new();
        let path = scratch.private_parent().join("proactive_run_pro_1");
        std::fs::create_dir_all(path.join("nested")).unwrap();
        std::fs::write(path.join("nested").join("left.txt"), "crash").unwrap();
        let folder =
            create_in(&scratch.parent(), "proactive_run_pro_1", SystemTime::now()).unwrap();
        assert_eq!(folder.path(), path);
        assert!(is_empty_dir(&path));
    }

    #[test]
    fn pruning_removes_only_old_entries_inside_the_parent() {
        let scratch = Scratch::new();
        let parent = scratch.private_parent();
        let old = parent.join("proactive_run_old");
        let fresh = parent.join("proactive_run_fresh");
        let outside = scratch.0.join("proactive_run_outside");
        for dir in [&old, &fresh, &outside] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("file.txt"), "data").unwrap();
        }
        std::fs::write(parent.join("old-file"), "data").unwrap();
        let two_days_ago = SystemTime::now() - 2 * DAY;
        set_modified(&old, two_days_ago);
        set_modified(&outside, two_days_ago);
        set_modified(&parent.join("old-file"), two_days_ago);

        let _folder = create_in(&parent, "proactive_run_new", SystemTime::now()).unwrap();
        assert!(!old.exists());
        assert!(!parent.join("old-file").exists());
        assert!(fresh.join("file.txt").exists());
        assert!(outside.join("file.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn links_are_removed_without_following_them() {
        let scratch = Scratch::new();
        let parent = scratch.private_parent();
        let outside = scratch.0.join("personal");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), "mine").unwrap();
        let link = |path: &Path| std::os::unix::fs::symlink(&outside, path).unwrap();

        // A stale link in the parent is pruned as a link.
        link(&parent.join("proactive_run_link"));
        let later = SystemTime::now() + 2 * DAY;
        drop(create_in(&parent, "proactive_run_other", later).unwrap());
        assert!(std::fs::symlink_metadata(parent.join("proactive_run_link")).is_err());

        // A run folder that is a link is replaced by a real folder.
        link(&parent.join("proactive_run_pro_1"));
        let folder = create_in(&parent, "proactive_run_pro_1", SystemTime::now()).unwrap();
        assert!(is_empty_dir(folder.path()));

        // A link the run made inside its folder is removed with the folder.
        link(&folder.path().join("home"));
        drop(folder);
        assert!(!parent.join("proactive_run_pro_1").exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "mine"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_parent_that_is_a_link_or_open_to_others_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new();
        let outside = scratch.0.join("personal");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, scratch.parent()).unwrap();
        assert!(create_in(&scratch.parent(), "proactive_run_pro_1", SystemTime::now()).is_err());
        assert!(is_empty_dir(&outside));

        std::fs::remove_file(scratch.parent()).unwrap();
        std::fs::create_dir(scratch.parent()).unwrap();
        std::fs::set_permissions(scratch.parent(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(create_in(&scratch.parent(), "proactive_run_pro_1", SystemTime::now()).is_err());
        assert!(is_empty_dir(&scratch.parent()));
    }
}
