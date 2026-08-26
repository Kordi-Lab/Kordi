pub(crate) fn should_publish_offline_on_exit(exit_code: Option<i32>) -> bool {
    exit_code != Some(tauri::RESTART_EXIT_CODE)
}

pub(crate) fn offline_url(base_url: &str) -> String {
    format!(
        "{}/v1/cloud/presence/offline",
        base_url.trim().trim_end_matches('/')
    )
}

fn publish_offline(token: &str, base_url: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|err| err.to_string())?
        .post(offline_url(base_url))
        .bearer_auth(token)
        .send()
        .map_err(|err| err.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("presence_offline_failed: {}", response.status()))
    }
}

pub(crate) fn publish_stored_offline_on_exit() {
    let session = match super::cloud_session::cloud_session_load() {
        Ok(Some(session)) => session,
        Ok(None) => return,
        Err(err) => {
            eprintln!("[kordi] Unable to load Cloud session for presence offline: {err}");
            return;
        }
    };
    let base_url = match super::cloud_api_base_url_from_env() {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[kordi] Unable to publish Cloud presence offline on quit: {err}");
            return;
        }
    };
    if let Err(err) = publish_offline(&session.token, &base_url) {
        eprintln!("[kordi] Unable to publish Cloud presence offline on quit: {err}");
    }
}
