use std::fs;
use std::path::PathBuf;
use std::process::Command;

const SYSTEMD_SERVICE_NAME: &str = "bridges-daemon.service";
const LAUNCHD_LABEL: &str = "ai.bridges.daemon";

enum ServicePlatform {
    SystemdUser,
    Launchd,
}

fn detect_platform() -> Result<ServicePlatform, String> {
    if cfg!(target_os = "macos") {
        return Ok(ServicePlatform::Launchd);
    }
    if cfg!(target_os = "linux") {
        return Ok(ServicePlatform::SystemdUser);
    }
    Err(
        "daemon service management is only supported on Linux (systemd user) and macOS (launchd)"
            .to_string(),
    )
}

fn home_dir() -> Result<PathBuf, String> {
    directories::BaseDirs::new()
        .map(|base| base.home_dir().to_path_buf())
        .ok_or_else(|| "cannot determine home directory".to_string())
}

fn current_exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|e| format!("cannot resolve current executable: {}", e))
}

fn inherited_path() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn systemd_service_path() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join(".config/systemd/user")
        .join(SYSTEMD_SERVICE_NAME))
}

fn launchd_plist_path() -> Result<PathBuf, String> {
    Ok(home_dir()?
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", LAUNCHD_LABEL)))
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("run {}: {}", cmd, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let msg = if !stderr.is_empty() { stderr } else { stdout };
        return Err(format!("{} {:?} failed: {}", cmd, args, msg));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_allow_failure(cmd: &str, args: &[&str]) {
    let _ = Command::new(cmd).args(args).output();
}

fn systemd_install() -> Result<String, String> {
    let service_path = systemd_service_path()?;
    let parent = service_path
        .parent()
        .ok_or_else(|| "invalid systemd service path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create systemd dir: {}", e))?;
    let exe = current_exe()?;
    let home = home_dir()?.to_string_lossy().to_string();
    let path = inherited_path();
    let content = format!(
        "[Unit]\nDescription=Bridges daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=\"HOME={home}\"\nEnvironment=\"PATH={path}\"\nExecStart={exe} daemon --foreground\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n",
        exe = exe,
        home = home,
        path = path
    );
    fs::write(&service_path, content).map_err(|e| format!("write service file: {}", e))?;
    run("systemctl", &["--user", "daemon-reload"])?;
    run(
        "systemctl",
        &["--user", "enable", "--now", SYSTEMD_SERVICE_NAME],
    )?;
    Ok(service_path.to_string_lossy().to_string())
}

fn systemd_uninstall() -> Result<(), String> {
    run_allow_failure(
        "systemctl",
        &["--user", "disable", "--now", SYSTEMD_SERVICE_NAME],
    );
    run_allow_failure("systemctl", &["--user", "daemon-reload"]);
    let path = systemd_service_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove service file: {}", e))?;
        run_allow_failure("systemctl", &["--user", "daemon-reload"]);
    }
    Ok(())
}

fn systemd_start() -> Result<(), String> {
    run("systemctl", &["--user", "start", SYSTEMD_SERVICE_NAME]).map(|_| ())
}

fn systemd_stop() -> Result<(), String> {
    run("systemctl", &["--user", "stop", SYSTEMD_SERVICE_NAME]).map(|_| ())
}

fn systemd_restart() -> Result<(), String> {
    run("systemctl", &["--user", "restart", SYSTEMD_SERVICE_NAME]).map(|_| ())
}

fn systemd_status() -> Result<String, String> {
    run("systemctl", &["--user", "is-active", SYSTEMD_SERVICE_NAME])
}

fn launchd_bootout_args(plist_path: &str) -> Result<Vec<String>, String> {
    let uid = run("id", &["-u"])?;
    Ok(vec![
        "bootout".to_string(),
        format!("gui/{}", uid),
        plist_path.to_string(),
    ])
}

fn launchd_bootstrap_args(plist_path: &str) -> Result<Vec<String>, String> {
    let uid = run("id", &["-u"])?;
    Ok(vec![
        "bootstrap".to_string(),
        format!("gui/{}", uid),
        plist_path.to_string(),
    ])
}

fn launchd_target() -> Result<String, String> {
    let uid = run("id", &["-u"])?;
    Ok(format!("gui/{}/{}", uid, LAUNCHD_LABEL))
}

fn launchd_install() -> Result<String, String> {
    let plist_path = launchd_plist_path()?;
    let parent = plist_path
        .parent()
        .ok_or_else(|| "invalid launchd plist path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("create launchd dir: {}", e))?;
    let exe = current_exe()?;
    let home = xml_escape(&home_dir()?.to_string_lossy());
    let path = xml_escape(&inherited_path());
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>daemon</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>{home}</string>
    <key>PATH</key>
    <string>{path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/bridges-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/bridges-daemon.log</string>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        exe = exe,
        home = home,
        path = path
    );
    fs::write(&plist_path, content).map_err(|e| format!("write plist: {}", e))?;
    let plist = plist_path.to_string_lossy().to_string();
    let bootout_args = launchd_bootout_args(&plist)?;
    let bootout_refs: Vec<&str> = bootout_args.iter().map(String::as_str).collect();
    run_allow_failure("launchctl", &bootout_refs);
    let bootstrap_args = launchd_bootstrap_args(&plist)?;
    let bootstrap_refs: Vec<&str> = bootstrap_args.iter().map(String::as_str).collect();
    run("launchctl", &bootstrap_refs)?;
    let target = launchd_target()?;
    run("launchctl", &["kickstart", "-k", &target])?;
    Ok(plist)
}

fn launchd_uninstall() -> Result<(), String> {
    let plist_path = launchd_plist_path()?;
    let plist = plist_path.to_string_lossy().to_string();
    let bootout_args = launchd_bootout_args(&plist)?;
    let bootout_refs: Vec<&str> = bootout_args.iter().map(String::as_str).collect();
    run_allow_failure("launchctl", &bootout_refs);
    if plist_path.exists() {
        fs::remove_file(&plist_path).map_err(|e| format!("remove plist: {}", e))?;
    }
    Ok(())
}

fn launchd_start() -> Result<(), String> {
    let plist_path = launchd_plist_path()?;
    let plist = plist_path.to_string_lossy().to_string();
    if !plist_path.exists() {
        return Err(format!(
            "launchd plist not installed: {} (run `bridges service install` first)",
            plist
        ));
    }
    let bootstrap_args = launchd_bootstrap_args(&plist)?;
    let bootstrap_refs: Vec<&str> = bootstrap_args.iter().map(String::as_str).collect();
    run_allow_failure("launchctl", &bootstrap_refs);
    let target = launchd_target()?;
    run("launchctl", &["kickstart", "-k", &target]).map(|_| ())
}

fn launchd_stop() -> Result<(), String> {
    let plist_path = launchd_plist_path()?;
    let plist = plist_path.to_string_lossy().to_string();
    let bootout_args = launchd_bootout_args(&plist)?;
    let bootout_refs: Vec<&str> = bootout_args.iter().map(String::as_str).collect();
    run("launchctl", &bootout_refs).map(|_| ())
}

fn launchd_restart() -> Result<(), String> {
    launchd_start()
}

fn launchd_status() -> Result<String, String> {
    let target = launchd_target()?;
    run("launchctl", &["print", &target]).map(|_| "running".to_string())
}

pub fn service_install() -> Result<String, String> {
    match detect_platform()? {
        ServicePlatform::SystemdUser => {
            let path = systemd_install()?;
            Ok(format!(
                "installed and started systemd user service at {}",
                path
            ))
        }
        ServicePlatform::Launchd => {
            let path = launchd_install()?;
            Ok(format!("installed and started launchd agent at {}", path))
        }
    }
}

pub fn service_uninstall() -> Result<String, String> {
    match detect_platform()? {
        ServicePlatform::SystemdUser => {
            systemd_uninstall()?;
            Ok("removed systemd user service".to_string())
        }
        ServicePlatform::Launchd => {
            launchd_uninstall()?;
            Ok("removed launchd agent".to_string())
        }
    }
}

pub fn service_start() -> Result<String, String> {
    match detect_platform()? {
        ServicePlatform::SystemdUser => {
            systemd_start()?;
            Ok("bridges daemon service started".to_string())
        }
        ServicePlatform::Launchd => {
            launchd_start()?;
            Ok("bridges daemon service started".to_string())
        }
    }
}

pub fn service_stop() -> Result<String, String> {
    match detect_platform()? {
        ServicePlatform::SystemdUser => {
            systemd_stop()?;
            Ok("bridges daemon service stopped".to_string())
        }
        ServicePlatform::Launchd => {
            launchd_stop()?;
            Ok("bridges daemon service stopped".to_string())
        }
    }
}

pub fn service_restart() -> Result<String, String> {
    match detect_platform()? {
        ServicePlatform::SystemdUser => {
            systemd_restart()?;
            Ok("bridges daemon service restarted".to_string())
        }
        ServicePlatform::Launchd => {
            launchd_restart()?;
            Ok("bridges daemon service restarted".to_string())
        }
    }
}

pub fn service_status() -> Result<String, String> {
    match detect_platform()? {
        ServicePlatform::SystemdUser => systemd_status(),
        ServicePlatform::Launchd => launchd_status(),
    }
}

pub fn try_start_service_if_installed() -> bool {
    match detect_platform() {
        Ok(ServicePlatform::SystemdUser) => {
            if let Ok(path) = systemd_service_path() {
                if path.exists() {
                    return systemd_start().is_ok();
                }
            }
            false
        }
        Ok(ServicePlatform::Launchd) => {
            if let Ok(path) = launchd_plist_path() {
                if path.exists() {
                    return launchd_start().is_ok();
                }
            }
            false
        }
        Err(_) => false,
    }
}
