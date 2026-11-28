//! API keys stored in the OS credential store (macOS Keychain, Windows
//! Credential Manager). Only names on the allowlists can be used, so the
//! frontend cannot use these commands to probe other secrets.
//!
//! The webview can read back only the keys for APIs it calls itself. The rest
//! are used by the backend: the webview can store or remove them and ask
//! whether they exist, but never read them.

use serde::Serialize;

const SERVICE: &str = "com.jarvis.desktop";
/// Keys the webview reads, because it calls those APIs itself.
const READABLE: &[&str] = &[
    "gemini_api_key",
    "openrouter_api_key",
    "deepseek_api_key",
    "discord_webhook_url",
];
/// Credentials the user types in Settings and only the backend reads.
const BACKEND_ONLY: &[&str] = &[
    "telegram_bot_token",
    "telegram_chat_id",
    "google_client_id",
    "google_client_secret",
    "spotify_client_id",
];
/// Written by the OAuth flow. The webview cannot read, set or delete them.
/// `google_refresh_token` is the single-account entry earlier builds wrote; it
/// is listed only so it can be deleted.
const OAUTH_TOKENS: &[&str] = &["google_refresh_token", "spotify_refresh_token"];
/// Each Google account has its own refresh token: this prefix and the account id.
const GOOGLE_TOKEN_PREFIX: &str = "google_refresh_token.";
/// Length of a Google account id (lowercase hex).
pub const ACCOUNT_ID_LENGTH: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("unknown secret: {0}")]
    NotAllowed(String),
    #[error("{0} cannot be used from the window")]
    Private(String),
    #[error("secret value must not be empty")]
    Empty,
    #[error("credential store error: {0}")]
    Store(#[from] keyring::Error),
}

impl Serialize for SecretError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub fn is_account_id(id: &str) -> bool {
    id.len() == ACCOUNT_ID_LENGTH && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The credential store name of one Google account's refresh token.
pub fn google_token_name(id: &str) -> Result<String, SecretError> {
    let name = format!("{GOOGLE_TOKEN_PREFIX}{id}");
    if is_account_id(id) {
        Ok(name)
    } else {
        Err(SecretError::NotAllowed(name))
    }
}

fn is_oauth_token(name: &str) -> bool {
    OAUTH_TOKENS.contains(&name)
        || name
            .strip_prefix(GOOGLE_TOKEN_PREFIX)
            .is_some_and(is_account_id)
}

fn is_allowed(name: &str) -> bool {
    READABLE.contains(&name) || BACKEND_ONLY.contains(&name) || is_oauth_token(name)
}

fn entry(name: &str) -> Result<keyring::Entry, SecretError> {
    if !is_allowed(name) {
        return Err(SecretError::NotAllowed(name.to_owned()));
    }
    Ok(keyring::Entry::new(SERVICE, name)?)
}

pub fn get(name: &str) -> Result<Option<String>, SecretError> {
    match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn set(name: &str, value: &str) -> Result<(), SecretError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(SecretError::Empty);
    }
    Ok(entry(name)?.set_password(value)?)
}

/// `get` for the webview: refuses secrets only the backend may read.
pub fn get_for_webview(name: &str) -> Result<Option<String>, SecretError> {
    if BACKEND_ONLY.contains(&name) || is_oauth_token(name) {
        return Err(SecretError::Private(name.to_owned()));
    }
    get(name)
}

/// `set` for the webview: refuses the tokens only the OAuth flow writes.
pub fn set_from_webview(name: &str, value: &str) -> Result<(), SecretError> {
    if is_oauth_token(name) {
        return Err(SecretError::Private(name.to_owned()));
    }
    set(name, value)
}

/// `delete` for the webview: accounts are disconnected through the OAuth commands.
pub fn delete_from_webview(name: &str) -> Result<(), SecretError> {
    if is_oauth_token(name) {
        return Err(SecretError::Private(name.to_owned()));
    }
    delete(name)
}

pub fn delete(name: &str) -> Result<(), SecretError> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_outside_the_allowlist() {
        assert!(matches!(get("aws_secret"), Err(SecretError::NotAllowed(_))));
        assert!(matches!(
            set("aws_secret", "x"),
            Err(SecretError::NotAllowed(_))
        ));
    }

    #[test]
    fn webview_cannot_read_backend_secrets_or_set_tokens() {
        for name in ["telegram_bot_token", "google_refresh_token"] {
            assert!(matches!(
                get_for_webview(name),
                Err(SecretError::Private(_))
            ));
        }
        assert!(matches!(
            set_from_webview("spotify_refresh_token", "x"),
            Err(SecretError::Private(_))
        ));
    }

    #[test]
    fn webview_cannot_touch_account_tokens() {
        let name = google_token_name("0123456789ab").expect("name");
        for result in [
            get_for_webview(&name).map(|_| ()),
            set_from_webview(&name, "x"),
            delete_from_webview(&name),
            delete_from_webview("spotify_refresh_token"),
        ] {
            assert!(matches!(result, Err(SecretError::Private(_))));
        }
    }

    #[test]
    fn account_token_names_need_a_well_formed_id() {
        for id in [
            "",
            "0123456789AB",
            "0123456789a",
            "0123456789abc",
            "../secret.xxx",
        ] {
            assert!(google_token_name(id).is_err(), "{id:?}");
            assert!(!is_allowed(&format!("google_refresh_token.{id}")), "{id:?}");
        }
    }

    #[test]
    fn rejects_empty_values() {
        assert!(matches!(
            set("gemini_api_key", "  "),
            Err(SecretError::Empty)
        ));
    }
}
