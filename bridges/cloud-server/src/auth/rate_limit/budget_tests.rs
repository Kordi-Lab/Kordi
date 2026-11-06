//! Per-route budgets: accounts, routes, and subject kinds never share a
//! counter, and operators can replace or switch off any named budget.

use super::budgets::NAMED_BUDGETS;
use super::*;

fn limiter_with(overrides: &str) -> CloudRateLimiter {
    CloudRateLimiter::memory(CloudRateLimitConfig::production())
        .with_budget_overrides(BudgetOverrides::parse(overrides).unwrap())
}

fn address(last: u8) -> Option<IpAddr> {
    Some(IpAddr::from([203, 0, 113, last]))
}

async fn spend(limiter: &CloudRateLimiter, limit: AccountActionLimit, account: &str) {
    for _ in 0..limit.limit {
        limiter.observe_account_limit(limit, account).await;
    }
}

fn is_limited(decision: RateLimitDecision) -> bool {
    matches!(decision, RateLimitDecision::Limited { .. })
}

#[tokio::test]
async fn one_accounts_burst_does_not_limit_another_account() {
    let limiter = limiter_with("");
    spend(&limiter, GROUP_INVITATION_CREATE_LIMIT, "acct_burst").await;
    assert!(is_limited(
        limiter
            .observe_account_limit(GROUP_INVITATION_CREATE_LIMIT, "acct_burst")
            .await
    ));
    assert_eq!(
        limiter
            .observe_account_limit(GROUP_INVITATION_CREATE_LIMIT, "acct_neighbour")
            .await,
        RateLimitDecision::Allowed
    );
}

#[tokio::test]
async fn reads_and_avatars_leave_invitation_links_alone() {
    // The reported failure: a signed-in user loading profiles and avatars used
    // up one shared per-address budget, then creating an invitation got a 429.
    let limiter = limiter_with("profile-lookup=5/1m,avatar-render-address=5/1m");
    for _ in 0..5 {
        limiter
            .observe_account_limit(PROFILE_LOOKUP_LIMIT, "acct_reader")
            .await;
        limiter
            .observe_address_limit(AVATAR_RENDER_ADDRESS_LIMIT, address(4))
            .await;
    }
    assert!(is_limited(
        limiter
            .observe_account_limit(PROFILE_LOOKUP_LIMIT, "acct_reader")
            .await
    ));
    assert!(is_limited(
        limiter
            .observe_address_limit(AVATAR_RENDER_ADDRESS_LIMIT, address(4))
            .await
    ));
    for limit in [GROUP_INVITATION_CREATE_LIMIT, INVITATION_ACCEPT_LIMIT] {
        assert_eq!(
            limiter.observe_account_limit(limit, "acct_reader").await,
            RateLimitDecision::Allowed,
            "{}",
            limit.action
        );
    }
    for limit in [LOGIN_ADDRESS_LIMIT, INVITATION_VIEW_ADDRESS_LIMIT] {
        assert_eq!(
            limiter.observe_address_limit(limit, address(4)).await,
            RateLimitDecision::Allowed,
            "{}",
            limit.action
        );
    }
}

#[tokio::test]
async fn subject_kinds_never_share_a_bucket() {
    let limiter = limiter_with("");
    let budget = AccountActionLimit {
        action: "shared-name",
        limit: 1,
        window: Duration::from_secs(60),
    };
    let subject = "203.0.113.9";
    assert_eq!(
        limiter.observe_account_limit(budget, subject).await,
        RateLimitDecision::Allowed
    );
    assert_eq!(
        limiter.observe_identifier_limit(budget, subject).await,
        RateLimitDecision::Allowed
    );
    assert_eq!(
        limiter.observe_address_limit(budget, address(9)).await,
        RateLimitDecision::Allowed
    );
    assert!(is_limited(
        limiter.observe_account_limit(budget, subject).await
    ));
}

#[tokio::test]
async fn sign_in_counts_per_address_and_per_email() {
    let limiter = limiter_with("login-address=3/1m,login-email=2/1m");
    let attempt = |client, email: &'static str| {
        limiter.observe_address_and_identifier(
            LOGIN_ADDRESS_LIMIT,
            client,
            LOGIN_EMAIL_LIMIT,
            email,
        )
    };
    // One email tried from many addresses runs out on its own budget.
    assert_eq!(
        attempt(address(1), "a@example.com").await,
        RateLimitDecision::Allowed
    );
    assert_eq!(
        attempt(address(2), "a@example.com").await,
        RateLimitDecision::Allowed
    );
    assert!(is_limited(attempt(address(3), "a@example.com").await));
    // Many emails from one address run out on the address budget.
    assert_eq!(
        attempt(address(5), "b@example.com").await,
        RateLimitDecision::Allowed
    );
    assert_eq!(
        attempt(address(5), "c@example.com").await,
        RateLimitDecision::Allowed
    );
    assert_eq!(
        attempt(address(5), "d@example.com").await,
        RateLimitDecision::Allowed
    );
    assert!(is_limited(attempt(address(5), "e@example.com").await));
    // Other people are unaffected.
    assert_eq!(
        attempt(address(6), "f@example.com").await,
        RateLimitDecision::Allowed
    );
}

#[tokio::test]
async fn refusals_report_the_remaining_wait() {
    let limiter = limiter_with("app-invitation-create=1/1h");
    limiter
        .observe_account_limit(APP_INVITATION_CREATE_LIMIT, "acct_wait")
        .await;
    match limiter
        .observe_account_limit(APP_INVITATION_CREATE_LIMIT, "acct_wait")
        .await
    {
        RateLimitDecision::Limited { retry_after } => {
            assert!(retry_after > Duration::from_secs(3_590));
            assert!(retry_after <= Duration::from_secs(3_600));
        }
        RateLimitDecision::Allowed => panic!("second invitation within the hour was allowed"),
    }
}

#[tokio::test]
async fn overrides_replace_or_switch_off_a_budget_and_still_scale_trusted_addresses() {
    let trusted = TrustedNetworks::parse(Some("198.51.100.0/24"), Some("3")).unwrap();
    let limiter = limiter_with("invitation-view-address=1/1m,profile-lookup=off")
        .with_trusted_networks(trusted);
    let outside = address(7);
    let inside = Some(IpAddr::from([198, 51, 100, 7]));
    limiter
        .observe_address_limit(INVITATION_VIEW_ADDRESS_LIMIT, outside)
        .await;
    assert!(is_limited(
        limiter
            .observe_address_limit(INVITATION_VIEW_ADDRESS_LIMIT, outside)
            .await
    ));
    for _ in 0..3 {
        assert_eq!(
            limiter
                .observe_address_limit(INVITATION_VIEW_ADDRESS_LIMIT, inside)
                .await,
            RateLimitDecision::Allowed
        );
    }
    assert!(is_limited(
        limiter
            .observe_address_limit(INVITATION_VIEW_ADDRESS_LIMIT, inside)
            .await
    ));
    for _ in 0..(PROFILE_LOOKUP_LIMIT.limit + 5) {
        assert_eq!(
            limiter
                .observe_account_limit(PROFILE_LOOKUP_LIMIT, "acct_off")
                .await,
            RateLimitDecision::Allowed
        );
    }
}

#[test]
fn overrides_parse_counts_windows_and_off() {
    let parsed = BudgetOverrides::parse(" login-address=60/90 , signup-email=3/2h,x=off ").unwrap();
    let login = parsed.apply(LOGIN_ADDRESS_LIMIT).unwrap();
    assert_eq!((login.limit, login.window), (60, Duration::from_secs(90)));
    let signup = parsed.apply(SIGNUP_EMAIL_LIMIT).unwrap();
    assert_eq!(
        (signup.limit, signup.window),
        (3, Duration::from_secs(7_200))
    );
    assert_eq!(
        parsed.apply(PROFILE_LOOKUP_LIMIT),
        Some(PROFILE_LOOKUP_LIMIT)
    );
    let off = AccountActionLimit {
        action: "x",
        ..PROFILE_LOOKUP_LIMIT
    };
    assert_eq!(parsed.apply(off), None);
    assert!(BudgetOverrides::parse("").unwrap().is_empty());
    for invalid in [
        "login-address",
        "login-address=60",
        "login-address=0/60",
        "login-address=60/0",
        "login-address=60/5w",
        "=60/60",
    ] {
        let error = BudgetOverrides::parse(invalid).unwrap_err();
        assert!(error.starts_with(BUDGETS_ENV), "{invalid}: {error}");
    }
}

#[test]
fn named_budgets_are_distinct_and_reads_are_generous() {
    let mut names = NAMED_BUDGETS.iter().map(|b| b.action).collect::<Vec<_>>();
    names.sort_unstable();
    let count = names.len();
    names.dedup();
    assert_eq!(names.len(), count, "two budgets share an action name");
    let per_minute =
        |limit: AccountActionLimit| f64::from(limit.limit) * 60.0 / limit.window.as_secs_f64();
    // Reads stay far above interactive use; sensitive writes stay tight.
    assert!(per_minute(PROFILE_LOOKUP_LIMIT) >= 300.0);
    assert!(per_minute(AVATAR_RENDER_ADDRESS_LIMIT) >= 120.0);
    assert!(per_minute(INVITATION_VIEW_ADDRESS_LIMIT) >= 60.0);
    assert!(per_minute(GROUP_INVITATION_CREATE_LIMIT) >= 30.0);
    assert!(per_minute(GROUP_INVITATION_RESET_LIMIT) < 1.0);
    assert!(per_minute(SIGNUP_CODE_EMAIL_LIMIT) < 1.0);
}
