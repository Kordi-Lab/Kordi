//! Cloud account auth: identity DB, password hashing, sessions, rate
//! limiting, and HTTP routes mounted under `/v1/cloud/auth/*` and
//! `/v1/cloud/contacts`.

mod account_email;
pub mod accounts;
pub mod admission;
pub mod app_sign_in;
pub mod devices;
pub(crate) mod identity_email;
pub mod legacy_signup;
pub(crate) mod oauth;
pub mod password;
pub mod rate_limit;
pub mod routes;
mod rows;
pub mod session;
pub mod session_activity;
pub(crate) mod session_signals;
pub mod signup_email;
pub mod subsessions;
