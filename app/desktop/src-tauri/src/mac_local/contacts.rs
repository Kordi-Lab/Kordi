//! Contacts reader through AppleScript (`osascript`), so the Automation
//! permission prompt covers it and no Contacts framework binding is needed.
//! The query is passed as a script argument after `--`, never spliced into
//! the script, so osascript cannot read it as an option.
use std::sync::Mutex;
use std::time::Duration;

use kordi_tools::mac_local::{MacContactsSearchRequest, MAX_CONTACTS};
use serde::Serialize;
use serde_json::{json, Value};

use super::MacLocalPermission;

const FIELD_SEPARATOR: char = '\u{1f}';
const RECORD_SEPARATOR: char = '\u{1e}';
const VALUE_SEPARATOR: char = '\u{1d}';
/// AppleScript error for "Not authorized to send Apple events".
const NOT_PERMITTED: &str = "-1743";

/// Name and organization match on substrings; email matches the full address.
const SEARCH_SCRIPT: &str = r#"on run argv
	set q to item 1 of argv
	set maxCount to (item 2 of argv) as integer
	set fieldSep to character id 31
	set recordSep to character id 30
	set valueSep to character id 29
	tell application "Contacts"
		set found to every person whose (name contains q) or (organization contains q)
		if (count of found) < maxCount then
			try
				set found to found & (every person whose value of emails contains q)
			end try
		end if
		set out to ""
		set seen to {}
		set n to 0
		repeat with p in found
			if n is greater than or equal to maxCount then exit repeat
			set pid to id of p
			if seen does not contain pid then
				set end of seen to pid
				set n to n + 1
				set nm to name of p
				if nm is missing value then set nm to ""
				set org to organization of p
				if org is missing value then set org to ""
				set em to ""
				repeat with e in (value of emails of p)
					set em to em & (e as text) & valueSep
				end repeat
				set ph to ""
				repeat with t in (value of phones of p)
					set ph to ph & (t as text) & valueSep
				end repeat
				set out to out & nm & fieldSep & em & fieldSep & ph & fieldSep & org & recordSep
			end if
		end repeat
	end tell
	return out
end run"#;

const COUNT_SCRIPT: &str = r#"tell application "Contacts" to count people"#;

static LAST_PROBE: Mutex<Option<MacLocalPermission>> = Mutex::new(None);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Contact {
    pub name: String,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
    pub organization: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ContactsError {
    PermissionDenied,
    Failed(String),
}

impl ContactsError {
    pub(crate) fn message(&self) -> String {
        match self {
            Self::PermissionDenied => "Contacts access is off. Allow Kordi to control Contacts in System Settings > Privacy & Security > Automation.".into(),
            Self::Failed(detail) => format!("Could not read Contacts on this Mac: {detail}"),
        }
    }
}

fn split_values(field: &str) -> Vec<String> {
    field
        .split(VALUE_SEPARATOR)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

/// Parses the delimited `osascript` output. A `-1743` error means the person
/// declined Automation access to Contacts.
pub(crate) fn parse_contacts_output(
    success: bool,
    stdout: &str,
    stderr: &str,
    limit: usize,
) -> Result<Vec<Contact>, ContactsError> {
    if stderr.contains(NOT_PERMITTED) {
        return Err(ContactsError::PermissionDenied);
    }
    if !success {
        let detail = stderr.trim();
        return Err(ContactsError::Failed(if detail.is_empty() {
            "osascript failed".into()
        } else {
            detail.chars().take(200).collect()
        }));
    }
    let output = stdout.strip_suffix('\n').unwrap_or(stdout);
    Ok(output
        .split(RECORD_SEPARATOR)
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let mut fields = record.split(FIELD_SEPARATOR);
            let name = fields.next()?.trim().to_string();
            let emails = split_values(fields.next().unwrap_or_default());
            let phones = split_values(fields.next().unwrap_or_default());
            let organization = fields
                .next()
                .map(str::trim)
                .filter(|org| !org.is_empty())
                .map(str::to_string);
            (!name.is_empty() || organization.is_some()).then_some(Contact {
                name,
                emails,
                phones,
                organization,
            })
        })
        .take(limit.min(MAX_CONTACTS))
        .collect())
}

fn remember(permission: MacLocalPermission) {
    if let Ok(mut last) = LAST_PROBE.lock() {
        *last = Some(permission);
    }
}

async fn osascript(args: &[&str], timeout: Duration) -> Result<(bool, String, String), String> {
    let mut command = tokio::process::Command::new("/usr/bin/osascript");
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| "Contacts did not answer in time.".to_string())?
        .map_err(|error| error.to_string())?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

/// Arguments for the search run. `--` ends osascript's option parsing, so
/// the query is always a script argument even if it looks like an option.
fn search_args<'a>(query: &'a str, limit_text: &'a str) -> [&'a str; 5] {
    ["-e", SEARCH_SCRIPT, "--", query, limit_text]
}

pub(crate) async fn search(request: MacContactsSearchRequest) -> Result<Value, String> {
    request.validate().map_err(|error| error.to_string())?;
    let limit = request.limit.min(MAX_CONTACTS);
    let limit_text = limit.to_string();
    let (success, stdout, stderr) = osascript(
        &search_args(request.query.trim(), &limit_text),
        Duration::from_secs(30),
    )
    .await?;
    match parse_contacts_output(success, &stdout, &stderr, limit) {
        Ok(contacts) => {
            remember(MacLocalPermission::Granted);
            Ok(json!({ "contacts": contacts }))
        }
        Err(error) => {
            if error == ContactsError::PermissionDenied {
                remember(MacLocalPermission::Denied);
            }
            Err(error.message())
        }
    }
}

/// Runs a harmless count so macOS shows the Automation prompt on first use.
/// Returns the permission and, when granted, the number of contacts.
pub(crate) async fn probe() -> (MacLocalPermission, Option<usize>) {
    if !cfg!(target_os = "macos") {
        return (MacLocalPermission::Unavailable, None);
    }
    // The first run waits for the person to answer the system prompt.
    let Ok((success, stdout, stderr)) =
        osascript(&["-e", COUNT_SCRIPT], Duration::from_secs(120)).await
    else {
        return (permission(), None);
    };
    let result = match parse_contacts_output(success, "", &stderr, 0) {
        Ok(_) => (
            MacLocalPermission::Granted,
            stdout.trim().parse::<usize>().ok(),
        ),
        Err(ContactsError::PermissionDenied) => (MacLocalPermission::Denied, None),
        Err(ContactsError::Failed(_)) => return (permission(), None),
    };
    remember(result.0);
    result
}

/// Current Automation permission for Contacts, without prompting.
pub(crate) fn permission() -> MacLocalPermission {
    #[cfg(target_os = "macos")]
    {
        match automation::status("com.apple.AddressBook") {
            Some(permission) => permission,
            None => LAST_PROBE
                .lock()
                .ok()
                .and_then(|last| *last)
                .unwrap_or(MacLocalPermission::NotDetermined),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        MacLocalPermission::Unavailable
    }
}

#[cfg(target_os = "macos")]
mod automation {
    use super::MacLocalPermission;
    use std::ffi::c_void;

    #[repr(C)]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn AECreateDesc(
            type_code: u32,
            data_ptr: *const c_void,
            data_size: isize,
            result: *mut AEDesc,
        ) -> i16;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            event_class: u32,
            event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
    }

    const TYPE_APPLICATION_BUNDLE_ID: u32 = u32::from_be_bytes(*b"bund");
    const TYPE_WILD_CARD: u32 = u32::from_be_bytes(*b"****");
    const NO_ERR: i32 = 0;
    const ERR_AE_EVENT_NOT_PERMITTED: i32 = -1743;
    const ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT: i32 = -1744;

    /// `None` when the answer is unknown, for example while the target app
    /// is not running (`procNotFound`).
    pub(super) fn status(bundle_id: &str) -> Option<MacLocalPermission> {
        let mut desc = AEDesc {
            descriptor_type: 0,
            data_handle: std::ptr::null_mut(),
        };
        let created = unsafe {
            AECreateDesc(
                TYPE_APPLICATION_BUNDLE_ID,
                bundle_id.as_ptr().cast(),
                bundle_id.len() as isize,
                &mut desc,
            )
        };
        if created != 0 {
            return None;
        }
        let status = unsafe {
            AEDeterminePermissionToAutomateTarget(&desc, TYPE_WILD_CARD, TYPE_WILD_CARD, 0)
        };
        unsafe { AEDisposeDesc(&mut desc) };
        match status {
            NO_ERR => Some(MacLocalPermission::Granted),
            ERR_AE_EVENT_NOT_PERMITTED => Some(MacLocalPermission::Denied),
            ERR_AE_EVENT_WOULD_REQUIRE_USER_CONSENT => Some(MacLocalPermission::NotDetermined),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contacts_parser_reads_delimited_records() {
        let stdout = format!(
            "Ada Lovelace{f}ada@example.com{v}ada@work.example{v}{f}+1 555 0100{v}{f}Analytical Engines{r}Grace Hopper{f}{f}{f}{r}\n",
            f = FIELD_SEPARATOR,
            v = VALUE_SEPARATOR,
            r = RECORD_SEPARATOR,
        );
        let contacts = parse_contacts_output(true, &stdout, "", 10).unwrap();
        assert_eq!(
            contacts,
            vec![
                Contact {
                    name: "Ada Lovelace".into(),
                    emails: vec!["ada@example.com".into(), "ada@work.example".into()],
                    phones: vec!["+1 555 0100".into()],
                    organization: Some("Analytical Engines".into()),
                },
                Contact {
                    name: "Grace Hopper".into(),
                    emails: vec![],
                    phones: vec![],
                    organization: None,
                },
            ]
        );
        assert!(parse_contacts_output(true, "\n", "", 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn contacts_parser_caps_rows_at_the_limit() {
        let stdout = (0..80)
            .map(|index| format!("Person {index}{FIELD_SEPARATOR}{FIELD_SEPARATOR}{FIELD_SEPARATOR}{RECORD_SEPARATOR}"))
            .collect::<String>();
        assert_eq!(
            parse_contacts_output(true, &stdout, "", 3).unwrap().len(),
            3
        );
        assert_eq!(
            parse_contacts_output(true, &stdout, "", 500).unwrap().len(),
            MAX_CONTACTS
        );
    }

    #[test]
    fn contacts_parser_maps_the_automation_error_to_permission_denied() {
        let stderr = "execution error: Not authorized to send Apple events to Contacts. (-1743)\n";
        assert_eq!(
            parse_contacts_output(false, "", stderr, 10),
            Err(ContactsError::PermissionDenied)
        );
        assert!(ContactsError::PermissionDenied
            .message()
            .contains("Automation"));
        assert!(matches!(
            parse_contacts_output(false, "", "execution error: boom (-2700)", 10),
            Err(ContactsError::Failed(detail)) if detail.contains("boom")
        ));
    }

    #[test]
    fn contacts_search_ends_options_before_the_query() {
        let args = search_args("-e do shell script \"id\"", "10");
        assert_eq!(args[..3], ["-e", SEARCH_SCRIPT, "--"]);
        assert_eq!(args[3], "-e do shell script \"id\"");
        assert_eq!(args[4], "10");
        let separator = args.iter().position(|arg| *arg == "--").unwrap();
        let query = args
            .iter()
            .rposition(|arg| arg.starts_with("-e do"))
            .unwrap();
        assert!(separator < query);
    }

    #[tokio::test]
    async fn contacts_search_rejects_option_like_queries_before_running() {
        let request = MacContactsSearchRequest {
            query: "-e do shell script \"touch /tmp/kordi-pwned\"".into(),
            limit: 5,
        };
        let error = search(request).await.unwrap_err();
        assert!(error.contains("must not start with '-'"), "{error}");
    }
}
