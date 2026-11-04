//! Browser sign-in for the Kordi apps: authorization code with PKCE.
//!
//! The app opens the system browser at the authorization endpoint, the user
//! signs in on a Kordi web page, and the browser hands a short-lived,
//! single-use authorization code back to the app through its registered
//! redirect URI, or shows it for the user to paste. The app exchanges the
//! code with its PKCE verifier for an access token and a rotating refresh
//! token. Tokens never appear in a URL.
//!
//! See `docs/development/browser-sign-in.md` for the endpoint contract.

/// Default path of the web page that signs the user in for an app.
pub const APP_SIGN_IN_PAGE_PATH: &str = "/sign-in/app";

pub mod clients;
pub mod codes;
pub mod tokens;

pub use clients::{AppClient, AppClientRegistry, APP_CLIENTS_ENV};
pub use codes::{AuthorizationGrant, CodeDelivery, IssuedCode, PresentedCode};
pub use tokens::{IssuedTokens, RefreshOutcome};
