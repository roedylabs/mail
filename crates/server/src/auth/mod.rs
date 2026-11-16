//! Sign-in to the app account:
//! passwords, usernames, sessions with device detection, multi-factor (authenticator apps,
//! recovery codes) and the extractors for handlers.

pub mod challenge;
pub mod device;
pub mod email;
pub mod extract;
pub mod password;
pub mod recovery;
pub mod session;
pub mod totp;
pub mod username;

pub use extract::{AdminUser, CurrentUser};
pub use session::AuthUser;
