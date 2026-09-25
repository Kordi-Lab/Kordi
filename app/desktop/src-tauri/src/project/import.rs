use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::Duration,
};
use tokio::process::Command;

use super::{
    default_new_project_parent, load_project_settings_for_root, resolve_explicit_project_folder,
    DesktopProjectSettings,
};

fn github_repository(raw: &str) -> Result<String, String> {
    let input = raw.trim().trim_end_matches('/');
    let path = input
        .strip_prefix("https://github.com/")
        .or_else(|| input.strip_prefix("git@github.com:"))
        .unwrap_or(input);
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.starts_with('-')
                || !part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    {
        return Err("Enter a GitHub repository URL or owner/repository.".into());
    }
    Ok(path.to_string())
}

fn github_cli() -> Option<PathBuf> {
    let mut directories =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    directories
        .into_iter()
        .map(|dir| dir.join(if cfg!(windows) { "gh.exe" } else { "gh" }))
        .find(|path| path.is_file())
}

async fn command_output(mut command: Command, seconds: u64) -> Result<Output, String> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(seconds), command.output())
        .await
        .map_err(|_| "The operation timed out. Check your connection and try again.".to_string())?
        .map_err(|_| {
            "Could not start the required application. Check that it is installed.".to_string()
        })
}

#[tauri::command]
pub async fn desktop_project_choose_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("/usr/bin/osascript");
        command.args([
            "-e",
            "POSIX path of (choose folder with prompt \"Choose a project folder\")",
        ]);
        command
    };
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; if ($picker.ShowDialog() -eq 'OK') { [Console]::Write($picker.SelectedPath) }"]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let command = {
        let mut command = Command::new("zenity");
        command.args([
            "--file-selection",
            "--directory",
            "--title=Choose a project folder",
        ]);
        command
    };
    let output = command_output(command, 600).await?;
    if !output.status.success() {
        if String::from_utf8_lossy(&output.stderr).contains("-128")
            || (!cfg!(target_os = "macos") && output.status.code() == Some(1))
        {
            return Ok(None);
        }
        return Err("Could not open the folder picker. Enter the folder path instead.".into());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Ok(None);
    }
    let resolved = resolve_explicit_project_folder(&path, false, false)?;
    Ok(Some(resolved.display().to_string()))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub full_name: String,
    pub description: Option<String>,
    pub language: Option<String>,
    pub private: bool,
}

#[derive(Deserialize)]
struct GithubApiRepository {
    full_name: String,
    description: Option<String>,
    language: Option<String>,
    private: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositoryPage {
    pub repositories: Vec<GithubRepository>,
    pub has_more: bool,
}

#[tauri::command]
pub async fn desktop_project_github_repositories(
    page: Option<u32>,
) -> Result<GithubRepositoryPage, String> {
    let executable = github_cli().ok_or("Install GitHub CLI and run gh auth login to list your repositories. You can also paste a public repository URL.")?;
    let mut command = Command::new(executable);
    let endpoint = format!("user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page={}", page.unwrap_or(1).clamp(1, 1000));
    command
        .args(["api", "--hostname", "github.com", &endpoint])
        .env("GH_PROMPT_DISABLED", "1");
    let output = command_output(command, 30).await?;
    if !output.status.success() {
        return Err("Unable to load GitHub repositories. Check your connection and run gh auth login, then refresh. You can also paste a repository URL.".into());
    }
    let repositories: Vec<GithubApiRepository> = serde_json::from_slice(&output.stdout)
        .map_err(|_| "GitHub returned an unexpected repository list.".to_string())?;
    let has_more = repositories.len() == 100;
    Ok(GithubRepositoryPage {
        has_more,
        repositories: repositories
            .into_iter()
            .map(|repo| GithubRepository {
                full_name: repo.full_name,
                description: repo.description,
                language: repo.language,
                private: repo.private,
            })
            .collect(),
    })
}

fn clone_command(repository: &str, destination: &Path, gh: Option<&Path>) -> Command {
    let mut command = Command::new("git");
    command.args(["-c", "credential.interactive=false"]);
    if let Some(gh) = gh {
        // Git helpers are shell snippets: quote the resolved executable, never user input.
        let executable = gh
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        command.args([
            "-c",
            "credential.https://github.com.helper=",
            "-c",
            &format!(
                "credential.https://github.com.helper=!'{}' auth git-credential",
                executable
            ),
        ]);
    }
    command
        .args([
            "clone",
            "--",
            &format!("https://github.com/{repository}.git"),
        ])
        .arg(destination)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1");
    command
}

#[tauri::command]
pub async fn desktop_project_clone_github(
    repository: String,
    parent_dir: Option<String>,
) -> Result<DesktopProjectSettings, String> {
    let repository = github_repository(&repository)?;
    // Account activation can change the process storage root while Git is running.
    // Keep registration bound to the database that initiated this operation.
    let database = project_registration_database();
    let parent = parent_dir
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(|path| resolve_explicit_project_folder(path, false, false))
        .transpose()?
        .unwrap_or_else(default_new_project_parent);
    std::fs::create_dir_all(&parent)
        .map_err(|_| "Could not create the project parent folder.".to_string())?;
    let destination = parent.join(repository.split('/').next_back().unwrap());
    // Atomically claim a new directory. Never clone into or delete an existing folder.
    std::fs::create_dir(&destination).map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists {
        "A folder with this repository name already exists. Choose another parent folder or add the existing local folder.".to_string()
    } else { "Could not create the project folder. Choose a writable location.".to_string() })?;
    let output = command_output(
        clone_command(&repository, &destination, github_cli().as_deref()),
        600,
    )
    .await;
    match output {
        Ok(output) if output.status.success() => {}
        result => {
            // A timed-out process may still have helpers shutting down. Preserve its folder.
            if result.is_ok() {
                let _ = std::fs::remove_dir_all(&destination);
            }
            return Err(match result {
                Err(error) => format!("{error} An incomplete folder may remain; choose another location before retrying."),
                _ => "Could not clone the repository. Check the URL, network, Git installation and repository access. For private repositories, run gh auth login and retry.".into(),
            });
        }
    }
    let root = std::fs::canonicalize(&destination)
        .map_err(|_| "Could not resolve the cloned project folder.".to_string())?;
    // Register without writing project settings into the user's checkout.
    register_cloned_project(&database, &root)?;
    Ok(load_project_settings_for_root(&root))
}

fn project_registration_database() -> PathBuf {
    kordi_core::config::session_db_path(&kordi_core::settings::Settings::load_global().storage)
}

fn register_cloned_project(database: &Path, root: &Path) -> Result<(), String> {
    let connection = kordi_session::store::open_db(database).map_err(|error| error.to_string())?;
    kordi_session::store::upsert_project(
        &connection,
        &format!("project:{}", root.display()),
        &root.display().to_string(),
        None,
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clone_registration_stays_with_the_initiating_account() {
        let _guard = crate::test_support::lock_process_environment();
        let previous = std::env::var_os("KORDI_STORAGE_ROOT");
        let directory =
            std::env::temp_dir().join(format!("kordi-clone-account-{}", uuid::Uuid::new_v4()));
        std::env::set_var("KORDI_STORAGE_ROOT", directory.join("first"));
        let initiating_database = project_registration_database();
        std::env::set_var("KORDI_STORAGE_ROOT", directory.join("second"));
        let other_database = project_registration_database();
        let outcome = register_cloned_project(&initiating_database, &directory.join("repository"));
        match previous {
            Some(value) => std::env::set_var("KORDI_STORAGE_ROOT", value),
            None => std::env::remove_var("KORDI_STORAGE_ROOT"),
        }
        outcome.unwrap();
        assert_ne!(initiating_database, other_database);
        let first = kordi_session::store::open_db(&initiating_database).unwrap();
        let second = kordi_session::store::open_db(&other_database).unwrap();
        assert_eq!(
            kordi_session::store::list_projects(&first).unwrap().len(),
            1
        );
        assert!(kordi_session::store::list_projects(&second)
            .unwrap()
            .is_empty());
        drop(first);
        drop(second);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn repository_input_rejects_other_hosts_credentials_options_and_traversal() {
        for input in [
            "https://github.com/team/app.git",
            "git@github.com:team/app.git",
            "team/app",
        ] {
            assert_eq!(github_repository(input).unwrap(), "team/app");
        }
        for input in [
            "https://evil.example/team/app",
            "https://token@github.com/team/app",
            "../app",
            "team/..",
            "team/-option",
            "team/app;touch-file",
            "team/app?token=secret",
            "file:///tmp/repo",
            "team/app/tree/main",
        ] {
            assert!(github_repository(input).is_err(), "{input}");
        }
    }
    #[tokio::test]
    async fn an_existing_clone_destination_is_never_modified() {
        let parent = std::env::temp_dir().join(format!("kordi-import-{}", uuid::Uuid::new_v4()));
        let existing = parent.join("repo");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("keep.txt"), "existing content").unwrap();
        let result =
            desktop_project_clone_github("team/repo".into(), Some(parent.display().to_string()))
                .await;
        assert!(result.unwrap_err().contains("already exists"));
        assert_eq!(
            std::fs::read_to_string(existing.join("keep.txt")).unwrap(),
            "existing content"
        );
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn existing_local_folders_accept_spaces() {
        let folder = std::env::temp_dir().join(format!("Kordi Project {}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        assert_eq!(
            resolve_explicit_project_folder(folder.to_str().unwrap(), false, false).unwrap(),
            std::fs::canonicalize(&folder).unwrap()
        );
        std::fs::remove_dir(folder).unwrap();
    }

    #[tokio::test]
    #[ignore = "requires a network connection to GitHub"]
    async fn public_repository_clones_without_github_cli() {
        let destination =
            std::env::temp_dir().join(format!("kordi-public-clone-{}", uuid::Uuid::new_v4()));
        let mut command = clone_command("octocat/Hello-World", &destination, None);
        command.env("GIT_CONFIG_NOSYSTEM", "1").env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
        let output = command_output(command, 60).await;
        let cloned = output.as_ref().is_ok_and(|output| output.status.success())
            && destination.join(".git").is_dir()
            && destination.join("README").is_file();
        if destination.exists() {
            std::fs::remove_dir_all(&destination).unwrap();
        }
        assert!(
            cloned,
            "public GitHub cloning should work without CLI authentication"
        );
    }

    #[test]
    fn clone_preserves_spaces_and_never_passes_user_input_to_a_shell() {
        let command = clone_command(
            "team/app",
            Path::new("/tmp/My Projects/app"),
            Some(Path::new("/tmp/Tools/gh")),
        );
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            &args[args.len() - 4..],
            [
                "clone",
                "--",
                "https://github.com/team/app.git",
                "/tmp/My Projects/app"
            ]
        );
    }
}
