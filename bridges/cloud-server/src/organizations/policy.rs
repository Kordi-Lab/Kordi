//! Who may change an organization's members. Pure rules, so every case is
//! unit tested; the handlers load the facts under a row lock and apply them.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrganizationRole {
    Owner,
    Admin,
    Member,
}

impl OrganizationRole {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    fn manages_members(self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MembershipChange {
    Add {
        role: OrganizationRole,
    },
    ChangeRole {
        from: OrganizationRole,
        to: OrganizationRole,
    },
    Remove {
        role: OrganizationRole,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    /// The caller is a plain member.
    NotManager,
    /// Personal organizations never gain members or lose their owner.
    PersonalOrganization,
    /// Only owners grant, change, or remove the owner role.
    OwnerRequired,
    /// The change would leave no owner.
    LastOwner,
}

/// Checks `change` by `actor` in an organization of `kind` that has
/// `owner_count` owners before the change.
pub fn check_membership_change(
    kind: &str,
    actor: OrganizationRole,
    change: MembershipChange,
    owner_count: i64,
) -> Result<(), PolicyError> {
    if !actor.manages_members() {
        return Err(PolicyError::NotManager);
    }
    if kind != super::TEAM_KIND {
        return Err(PolicyError::PersonalOrganization);
    }
    let (before, after) = match change {
        MembershipChange::Add { role } => (None, Some(role)),
        MembershipChange::ChangeRole { from, to } => (Some(from), Some(to)),
        MembershipChange::Remove { role } => (Some(role), None),
    };
    let touches_owner =
        before == Some(OrganizationRole::Owner) || after == Some(OrganizationRole::Owner);
    if touches_owner && actor != OrganizationRole::Owner {
        return Err(PolicyError::OwnerRequired);
    }
    let loses_owner =
        before == Some(OrganizationRole::Owner) && after != Some(OrganizationRole::Owner);
    if loses_owner && owner_count <= 1 {
        return Err(PolicyError::LastOwner);
    }
    Ok(())
}

/// Checks that an account with `role` may leave an organization of `kind`
/// that has `owner_count` owners. Any member may leave a team, except its
/// last owner, who must name another owner first.
pub fn check_leave(
    kind: &str,
    role: OrganizationRole,
    owner_count: i64,
) -> Result<(), PolicyError> {
    if kind != super::TEAM_KIND {
        return Err(PolicyError::PersonalOrganization);
    }
    if role == OrganizationRole::Owner && owner_count <= 1 {
        return Err(PolicyError::LastOwner);
    }
    Ok(())
}

/// Whether `role` may move content into or out of an organization.
pub fn manages_content(role: OrganizationRole) -> bool {
    role.manages_members()
}

#[cfg(test)]
mod tests {
    use super::OrganizationRole::{Admin, Member, Owner};
    use super::*;

    const TEAM: &str = "team";

    #[test]
    fn roles_round_trip_and_reject_unknown_values() {
        for role in [Owner, Admin, Member] {
            assert_eq!(OrganizationRole::parse(role.as_str()), Some(role));
        }
        assert_eq!(OrganizationRole::parse("Owner"), None);
        assert_eq!(OrganizationRole::parse("superuser"), None);
    }

    #[test]
    fn members_cannot_change_anything() {
        for change in [
            MembershipChange::Add { role: Member },
            MembershipChange::ChangeRole {
                from: Member,
                to: Admin,
            },
            MembershipChange::Remove { role: Member },
        ] {
            assert_eq!(
                check_membership_change(TEAM, Member, change, 2),
                Err(PolicyError::NotManager)
            );
        }
    }

    #[test]
    fn personal_organizations_never_change() {
        for change in [
            MembershipChange::Add { role: Member },
            MembershipChange::ChangeRole {
                from: Owner,
                to: Admin,
            },
            MembershipChange::Remove { role: Owner },
        ] {
            assert_eq!(
                check_membership_change("personal", Owner, change, 1),
                Err(PolicyError::PersonalOrganization)
            );
        }
    }

    #[test]
    fn admins_manage_non_owners_only() {
        assert_eq!(
            check_membership_change(TEAM, Admin, MembershipChange::Add { role: Admin }, 1),
            Ok(())
        );
        assert_eq!(
            check_membership_change(
                TEAM,
                Admin,
                MembershipChange::ChangeRole {
                    from: Admin,
                    to: Member
                },
                1
            ),
            Ok(())
        );
        for change in [
            MembershipChange::Add { role: Owner },
            MembershipChange::ChangeRole {
                from: Member,
                to: Owner,
            },
            MembershipChange::ChangeRole {
                from: Owner,
                to: Member,
            },
            MembershipChange::Remove { role: Owner },
        ] {
            assert_eq!(
                check_membership_change(TEAM, Admin, change, 3),
                Err(PolicyError::OwnerRequired)
            );
        }
    }

    #[test]
    fn members_leave_a_team_but_the_last_owner_stays() {
        assert_eq!(check_leave(TEAM, Member, 1), Ok(()));
        assert_eq!(check_leave(TEAM, Admin, 1), Ok(()));
        assert_eq!(check_leave(TEAM, Owner, 2), Ok(()));
        assert_eq!(check_leave(TEAM, Owner, 1), Err(PolicyError::LastOwner));
        assert_eq!(
            check_leave("personal", Owner, 1),
            Err(PolicyError::PersonalOrganization)
        );
        assert!(manages_content(Owner) && manages_content(Admin));
        assert!(!manages_content(Member));
    }

    #[test]
    fn the_last_owner_stays() {
        let demote = MembershipChange::ChangeRole {
            from: Owner,
            to: Admin,
        };
        let remove = MembershipChange::Remove { role: Owner };
        for change in [demote, remove] {
            assert_eq!(
                check_membership_change(TEAM, Owner, change, 1),
                Err(PolicyError::LastOwner)
            );
            assert_eq!(check_membership_change(TEAM, Owner, change, 2), Ok(()));
        }
        assert_eq!(
            check_membership_change(
                TEAM,
                Owner,
                MembershipChange::ChangeRole {
                    from: Owner,
                    to: Owner
                },
                1
            ),
            Ok(()),
            "keeping the role is not a demotion"
        );
    }
}
