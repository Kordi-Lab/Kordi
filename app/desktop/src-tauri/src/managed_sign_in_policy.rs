//! Managed sign-in policy (docs/development/managed-devices.md).
//!
//! An organization pins the app to its own accounts through the macOS
//! managed preferences domain `ai.kordi.desktop`. A key counts only when the
//! system reports it as forced, so a value written with `defaults write` is
//! ignored. The policy never comes from a server.

use serde::Serialize;

const DOMAIN: &str = "ai.kordi.desktop";
const METHODS_KEY: &str = "allowed_sign_in_methods";
const ORGANIZATIONS_KEY: &str = "allowed_organizations";
const KNOWN_METHODS: [&str; 3] = ["google", "github", "email"];

/// `None` for a field means the key is missing and does not restrict
/// anything; an empty list allows nothing.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSignInPolicy {
    pub allowed_sign_in_methods: Option<Vec<String>>,
    pub allowed_organizations: Option<Vec<String>>,
}

/// A forced preference value, reduced to what the policy needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ManagedValue {
    /// An array whose items are all strings.
    Strings(Vec<String>),
    /// Anything else: a scalar, a dictionary, or an array with a non-string item.
    Other,
}

/// Valid method names, trimmed and lowercased; unknown entries are ignored.
pub(crate) fn parse_methods(value: Option<ManagedValue>) -> Option<Vec<String>> {
    let entries = match value? {
        ManagedValue::Strings(entries) => entries,
        ManagedValue::Other => return Some(Vec::new()),
    };
    let mut methods = Vec::new();
    for entry in entries {
        let method = entry.trim().to_ascii_lowercase();
        if KNOWN_METHODS.contains(&method.as_str()) && !methods.contains(&method) {
            methods.push(method);
        }
    }
    Some(methods)
}

/// Organization ids, trimmed and compared exactly; empty entries are ignored.
pub(crate) fn parse_organizations(value: Option<ManagedValue>) -> Option<Vec<String>> {
    let entries = match value? {
        ManagedValue::Strings(entries) => entries,
        ManagedValue::Other => return Some(Vec::new()),
    };
    let mut organizations = Vec::new();
    for entry in entries {
        let id = entry.trim();
        if !id.is_empty() && !organizations.iter().any(|known| known == id) {
            organizations.push(id.to_string());
        }
    }
    Some(organizations)
}

pub(crate) fn policy_from_values(
    methods: Option<ManagedValue>,
    organizations: Option<ManagedValue>,
) -> ManagedSignInPolicy {
    ManagedSignInPolicy {
        allowed_sign_in_methods: parse_methods(methods),
        allowed_organizations: parse_organizations(organizations),
    }
}

/// Debug builds accept a policy from `KORDI_DEV_MANAGED_SIGN_IN_POLICY` (the
/// same keys as JSON) for previews and tests. Release builds never read it.
fn debug_override() -> Option<ManagedSignInPolicy> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let raw = std::env::var("KORDI_DEV_MANAGED_SIGN_IN_POLICY").ok()?;
    Some(policy_from_json(&raw))
}

/// Parses the debug override. Unreadable JSON allows nothing (fail closed).
pub(crate) fn policy_from_json(raw: &str) -> ManagedSignInPolicy {
    let Ok(serde_json::Value::Object(object)) = serde_json::from_str::<serde_json::Value>(raw)
    else {
        return ManagedSignInPolicy {
            allowed_sign_in_methods: Some(Vec::new()),
            allowed_organizations: Some(Vec::new()),
        };
    };
    let value = |key: &str| {
        object.get(key).map(|value| match value.as_array() {
            Some(items) => items
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .map_or(ManagedValue::Other, ManagedValue::Strings),
            None => ManagedValue::Other,
        })
    };
    policy_from_values(value(METHODS_KEY), value(ORGANIZATIONS_KEY))
}

pub(crate) fn current_policy() -> ManagedSignInPolicy {
    if let Some(policy) = debug_override() {
        return policy;
    }
    policy_from_values(
        platform::forced_value(DOMAIN, METHODS_KEY),
        platform::forced_value(DOMAIN, ORGANIZATIONS_KEY),
    )
}

#[tauri::command]
pub fn managed_sign_in_policy() -> ManagedSignInPolicy {
    current_policy()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ManagedValue;
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFArrayRef = *const c_void;
    type CFIndex = isize;
    type CFTypeID = usize;
    type Boolean = u8;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFPreferencesAppValueIsForced(key: CFStringRef, application_id: CFStringRef) -> Boolean;
        fn CFPreferencesCopyAppValue(key: CFStringRef, application_id: CFStringRef) -> CFTypeRef;
        fn CFStringCreateWithBytes(
            allocator: CFTypeRef,
            bytes: *const u8,
            num_bytes: CFIndex,
            encoding: u32,
            is_external_representation: Boolean,
        ) -> CFStringRef;
        fn CFStringGetTypeID() -> CFTypeID;
        fn CFStringGetLength(string: CFStringRef) -> CFIndex;
        fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
        fn CFStringGetCString(
            string: CFStringRef,
            buffer: *mut u8,
            buffer_size: CFIndex,
            encoding: u32,
        ) -> Boolean;
        fn CFArrayGetTypeID() -> CFTypeID;
        fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
        fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> CFTypeRef;
        fn CFGetTypeID(value: CFTypeRef) -> CFTypeID;
        fn CFRelease(value: CFTypeRef);
    }

    /// An owned CoreFoundation reference released on drop.
    struct Owned(CFTypeRef);

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_string(value: &str) -> Option<Owned> {
        let string = unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                value.as_ptr(),
                value.len() as CFIndex,
                K_CF_STRING_ENCODING_UTF8,
                0,
            )
        };
        (!string.is_null()).then_some(Owned(string))
    }

    /// Copies a CFString; `value` must be a valid CFString.
    unsafe fn rust_string(value: CFStringRef) -> Option<String> {
        let length = CFStringGetLength(value);
        let capacity = CFStringGetMaximumSizeForEncoding(length, K_CF_STRING_ENCODING_UTF8) + 1;
        let mut buffer = vec![0u8; usize::try_from(capacity).ok()?];
        if CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            capacity,
            K_CF_STRING_ENCODING_UTF8,
        ) == 0
        {
            return None;
        }
        let end = buffer.iter().position(|byte| *byte == 0)?;
        buffer.truncate(end);
        String::from_utf8(buffer).ok()
    }

    /// Reduces a preference value; `value` must be a valid CF object.
    unsafe fn managed_value(value: CFTypeRef) -> ManagedValue {
        if CFGetTypeID(value) != CFArrayGetTypeID() {
            return ManagedValue::Other;
        }
        let mut entries = Vec::new();
        for index in 0..CFArrayGetCount(value) {
            let item = CFArrayGetValueAtIndex(value, index);
            if item.is_null() || CFGetTypeID(item) != CFStringGetTypeID() {
                return ManagedValue::Other;
            }
            match rust_string(item) {
                Some(entry) => entries.push(entry),
                None => return ManagedValue::Other,
            }
        }
        ManagedValue::Strings(entries)
    }

    /// The value of `key` when a configuration profile forces it, else `None`.
    pub(super) fn forced_value(domain: &str, key: &str) -> Option<ManagedValue> {
        let domain = cf_string(domain)?;
        let key = cf_string(key)?;
        if unsafe { CFPreferencesAppValueIsForced(key.0, domain.0) } == 0 {
            return None;
        }
        let value = Owned(unsafe { CFPreferencesCopyAppValue(key.0, domain.0) });
        if value.0.is_null() {
            // Forced but unreadable: a present key with no valid entry.
            return Some(ManagedValue::Other);
        }
        Some(unsafe { managed_value(value.0) })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::ManagedValue;

    pub(super) fn forced_value(_domain: &str, _key: &str) -> Option<ManagedValue> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Option<ManagedValue> {
        Some(ManagedValue::Strings(
            values.iter().map(|value| value.to_string()).collect(),
        ))
    }

    #[test]
    fn missing_keys_do_not_restrict() {
        assert_eq!(
            policy_from_values(None, None),
            ManagedSignInPolicy::default()
        );
    }

    #[test]
    fn methods_are_trimmed_lowercased_and_filtered() {
        assert_eq!(
            parse_methods(strings(&[" Google ", "EMAIL", "sso", "google", ""])),
            Some(vec!["google".to_string(), "email".to_string()])
        );
    }

    #[test]
    fn a_key_with_no_valid_entry_allows_nothing() {
        assert_eq!(parse_methods(strings(&["sso"])), Some(Vec::new()));
        assert_eq!(parse_methods(strings(&[])), Some(Vec::new()));
        assert_eq!(parse_methods(Some(ManagedValue::Other)), Some(Vec::new()));
        assert_eq!(
            parse_organizations(Some(ManagedValue::Other)),
            Some(Vec::new())
        );
        assert_eq!(parse_organizations(strings(&["  "])), Some(Vec::new()));
    }

    #[test]
    fn organizations_are_trimmed_and_compared_exactly() {
        assert_eq!(
            parse_organizations(strings(&[
                " example-university ",
                "org_test123",
                "Example-University",
                "org_test123",
                "",
            ])),
            Some(vec![
                "example-university".to_string(),
                "org_test123".to_string(),
                "Example-University".to_string(),
            ])
        );
    }

    #[test]
    fn the_debug_override_uses_the_same_rules() {
        let policy = policy_from_json(
            r#"{"allowed_sign_in_methods":["github"],"allowed_organizations":["org_test"]}"#,
        );
        assert_eq!(
            policy.allowed_sign_in_methods,
            Some(vec!["github".to_string()])
        );
        assert_eq!(
            policy.allowed_organizations,
            Some(vec!["org_test".to_string()])
        );
        let mixed = policy_from_json(r#"{"allowed_sign_in_methods":["google",1]}"#);
        assert_eq!(mixed.allowed_sign_in_methods, Some(Vec::new()));
        assert_eq!(mixed.allowed_organizations, None);
        let scalar = policy_from_json(r#"{"allowed_organizations":"org_test"}"#);
        assert_eq!(scalar.allowed_organizations, Some(Vec::new()));
        let broken = policy_from_json("not json");
        assert_eq!(broken.allowed_sign_in_methods, Some(Vec::new()));
        assert_eq!(broken.allowed_organizations, Some(Vec::new()));
    }

    #[test]
    fn the_policy_serializes_with_camel_case_keys() {
        let json = serde_json::to_value(ManagedSignInPolicy {
            allowed_sign_in_methods: Some(vec!["google".into()]),
            allowed_organizations: None,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"allowedSignInMethods": ["google"], "allowedOrganizations": null})
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_unmanaged_key_is_not_forced() {
        // Test machines carry no profile for this key.
        assert_eq!(
            platform::forced_value(DOMAIN, "kordi_test_unmanaged_key"),
            None
        );
    }
}
