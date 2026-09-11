//! Local path interpretation shared by file tools, shell workdirs and input references.
use std::path::{Path, PathBuf};

pub fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn resolve_local_path(cwd: &Path, value: &str) -> PathBuf {
    resolve_with_home(cwd, value, home_directory().as_deref())
}

fn resolve_with_home(cwd: &Path, value: &str, home: Option<&Path>) -> PathBuf {
    let value = value.strip_prefix('@').unwrap_or(value);
    let expanded = match (value, home) {
        ("~", Some(home)) => home.to_path_buf(),
        (value, Some(home)) if value.starts_with("~/") => {
            home.join(value[2..].trim_start_matches('/'))
        }
        _ => PathBuf::from(value),
    };
    // Do not lexically remove `..`: a preceding component may be a symlink.
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_home_references_are_not_relative_to_the_app_directory() {
        let cwd = Path::new("/app/work");
        let home = Some(Path::new("/home/test-owner"));
        for value in ["~/project", "@~/project", "~//project"] {
            assert_eq!(
                resolve_with_home(cwd, value, home),
                Path::new("/home/test-owner/project")
            );
        }
        assert_eq!(resolve_with_home(cwd, "~", home), home.unwrap());
        assert_eq!(
            resolve_with_home(cwd, "@./My Project/source.rs", home),
            cwd.join("./My Project/source.rs")
        );
        assert_eq!(
            resolve_with_home(cwd, "/data/project", home),
            Path::new("/data/project")
        );
        assert_eq!(
            resolve_with_home(cwd, "~someone/project", home),
            cwd.join("~someone/project")
        );
    }
}
