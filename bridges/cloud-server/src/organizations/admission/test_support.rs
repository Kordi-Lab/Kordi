//! A synthetic admission file for tests. Only `example.test` values.

use serde_json::{json, Value};

use super::config::{ConfiguredOrganization, OrganizationAdmission};

pub const ADMINS_ENV: &str = "KORDI_ORG_EXAMPLE_ADMINS";

/// One active organization claiming `example.test` exactly, requiring a
/// Google hosted domain, auto-joining by Google or email code.
pub fn sample_file(id: &str) -> Value {
    json!({
        "version": 1,
        "personalOrganizations": { "pool": "default" },
        "organizations": [{
            "id": id,
            "displayName": "Example Research",
            "state": "active",
            "pool": "example-pool",
            "targetPool": "example-pool",
            "admission": {
                "claimedDomains": ["example.test"],
                "domainMatch": "exact",
                "requireGoogleHostedDomain": true,
                "autoJoinMethods": ["google", "email_code"],
                "reverifyIntervalMonths": 6,
                "googleSignInReverifies": true,
                "joinRequests": {
                    "enabled": true,
                    "approval": "organization_admins",
                    "fields": [
                        { "key": "affiliation", "label": "Affiliation", "required": true, "maxLength": 40 },
                        { "key": "purpose", "label": "Purpose", "required": null, "maxLength": null }
                    ],
                    "retentionDays": 30,
                    "approvedMembershipExpiry": "set_by_approver"
                }
            },
            "membership": {
                "requireMemberOwner": true,
                "outsidersAllowed": true,
                "workEndBoundSeconds": null
            },
            "adminsEnv": ADMINS_ENV,
            "entryPage": {
                "title": "Example Research",
                "summary": "For example.test researchers.",
                "joinLabel": "Join Example Research",
                "notOpenText": "Example Research is not open yet."
            }
        }]
    })
}

/// Parses `file` with `admins` as the admins variable's JSON value.
pub fn parse(file: &Value, admins: &str) -> Result<OrganizationAdmission, String> {
    let admins = admins.to_string();
    OrganizationAdmission::parse(&file.to_string(), move |key| {
        (key == ADMINS_ENV).then(|| admins.clone())
    })
}

/// The first organization of the sample after `edit`, unsynced.
pub fn organization(edit: impl FnOnce(&mut Value)) -> ConfiguredOrganization {
    let mut file = sample_file("example-research");
    edit(&mut file["organizations"][0]);
    parse(&file, "[]").unwrap().organizations.remove(0)
}
