//! Sign-in hints from managed devices (docs/development/managed-devices.md).
//! A hint only shapes the sign-in page; it never grants or refuses anything.
//! Invalid values are dropped.

use super::config::OrganizationAdmission;

const MAX_HINT_CHARS: usize = 63;
const METHODS: [&str; 3] = ["google", "github", "email"];

/// A well-formed organization hint: a configuration id or an `org_` id.
pub fn organization_hint(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    let valid = !value.is_empty()
        && value.len() <= MAX_HINT_CHARS
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    valid.then_some(value)
}

/// The known methods of a comma-separated list, deduplicated in the fixed
/// order google, github, email; `None` when none is known.
pub fn sign_in_methods_hint(value: Option<&str>) -> Option<String> {
    let listed: Vec<String> = value?
        .split(',')
        .map(|method| method.trim().to_ascii_lowercase())
        .collect();
    let known: Vec<&str> = METHODS
        .into_iter()
        .filter(|method| listed.iter().any(|listed| listed == method))
        .collect();
    (!known.is_empty()).then(|| known.join(","))
}

impl OrganizationAdmission {
    /// The Google `hd` value for an organization hint: the one claimed domain
    /// of an open configured organization named by configuration id or
    /// organization id.
    pub fn google_hosted_domain_hint(&self, hint: Option<&str>) -> Option<&str> {
        let hint = organization_hint(hint)?;
        let org = self.organizations.iter().find(|o| {
            o.id == hint || (!o.organization_id.is_empty() && o.organization_id == hint)
        })?;
        match (org.state.admits(), org.claim.domains.as_slice()) {
            (true, [domain]) => Some(domain),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::{parse, sample_file};
    use super::*;

    #[test]
    fn organization_hints_are_ids_only() {
        assert_eq!(
            organization_hint(Some(" example-research ")),
            Some("example-research")
        );
        assert_eq!(
            organization_hint(Some("org_0123abcd")),
            Some("org_0123abcd")
        );
        assert_eq!(organization_hint(Some("Example")), None);
        assert_eq!(organization_hint(Some("a b")), None);
        assert_eq!(organization_hint(Some("")), None);
        assert_eq!(organization_hint(Some(&"a".repeat(64))), None);
        assert_eq!(organization_hint(None), None);
    }

    #[test]
    fn method_hints_keep_known_methods_in_a_fixed_order() {
        assert_eq!(
            sign_in_methods_hint(Some("email, GOOGLE,google")).as_deref(),
            Some("google,email")
        );
        assert_eq!(
            sign_in_methods_hint(Some("github")).as_deref(),
            Some("github")
        );
        assert_eq!(sign_in_methods_hint(Some("password,x")), None);
        assert_eq!(sign_in_methods_hint(Some("")), None);
        assert_eq!(sign_in_methods_hint(None), None);
    }

    #[test]
    fn google_hint_names_the_single_domain_of_an_open_organization() {
        let mut admission = parse(&sample_file("example-research"), "[]").unwrap();
        admission.organizations[0].organization_id = "org_example".into();
        assert_eq!(
            admission.google_hosted_domain_hint(Some("example-research")),
            Some("example.test")
        );
        assert_eq!(
            admission.google_hosted_domain_hint(Some("org_example")),
            Some("example.test")
        );
        assert_eq!(
            admission.google_hosted_domain_hint(Some("other-research")),
            None
        );
        assert_eq!(admission.google_hosted_domain_hint(None), None);

        admission.organizations[0]
            .claim
            .domains
            .push("second.test".into());
        assert_eq!(
            admission.google_hosted_domain_hint(Some("example-research")),
            None
        );

        let mut file = sample_file("example-research");
        file["organizations"][0]["state"] = json!("disabled");
        let disabled = parse(&file, "[]").unwrap();
        assert_eq!(
            disabled.google_hosted_domain_hint(Some("example-research")),
            None
        );
    }
}
