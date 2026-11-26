//! API keys stored in the OS credential store (macOS Keychain, Windows
//! Credential Manager). Only names on the allowlist can be read or written,
//! so the frontend cannot use these commands to probe other secrets.

use serde::Serialize;

const SERVICE: &str = "com.jarvis.desktop";
const ALLOWED: &[&str] = &["gemini_api_key"];

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("unknown secret: {0}")]
    NotAllowed(String),
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

fn entry(name: &str) -> Result<keyring::Entry, SecretError> {
    if !ALLOWED.contains(&name) {
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
    fn rejects_empty_values() {
        assert!(matches!(
            set("gemini_api_key", "  "),
            Err(SecretError::Empty)
        ));
    }
}
