//! JSON documents kept in the app data folder (memory, profile, goals,
//! protocols). Only the webview writes these documents, so there is a single
//! writer and no cross-process locking. Writes go to a temporary file first
//! and are renamed into place, so a crash cannot leave a half-written file.
//!
//! Reminders are not stored here: the backend scheduler owns them (see
//! `reminders.rs`).

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// Documents the frontend may read and write. Anything else is refused, so
/// the webview cannot use these commands to touch arbitrary files.
pub const ALLOWED: &[&str] = &[
    "memory",
    "profile",
    "goals",
    "protocols",
    "settings",
    "rules",
];

/// Folder for the documents. Managed as Tauri state.
#[derive(Debug, Clone)]
pub struct DataDir(pub PathBuf);

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("unknown document: {0}")]
    NotAllowed(String),
    #[error("could not access {path}: {message}")]
    Io { path: String, message: String },
    #[error("document {name} is not valid JSON: {message}")]
    Parse { name: String, message: String },
}

impl Serialize for DataError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

fn check_name(name: &str) -> Result<(), DataError> {
    if ALLOWED.contains(&name) {
        Ok(())
    } else {
        Err(DataError::NotAllowed(name.to_owned()))
    }
}

fn io_error(path: &Path, error: std::io::Error) -> DataError {
    DataError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}

/// Reads a document. A missing file is `Ok(None)`, not an error.
pub fn read(dir: &Path, name: &str) -> Result<Option<Value>, DataError> {
    check_name(name)?;
    read_any(dir, name)
}

/// Replaces a document atomically.
pub fn write(dir: &Path, name: &str, value: &Value) -> Result<(), DataError> {
    check_name(name)?;
    write_any(dir, name, value)
}

/// Reads any document in the folder. Backend services use this for their own
/// files (reminders); the webview never reaches it.
pub(crate) fn read_any(dir: &Path, name: &str) -> Result<Option<Value>, DataError> {
    let path = dir.join(format!("{name}.json"));
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| DataError::Parse {
                name: name.to_owned(),
                message: error.to_string(),
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(&path, error)),
    }
}

/// Writes any document in the folder atomically.
pub(crate) fn write_any(dir: &Path, name: &str, value: &Value) -> Result<(), DataError> {
    fs::create_dir_all(dir).map_err(|error| io_error(dir, error))?;
    let path = dir.join(format!("{name}.json"));
    let temp = dir.join(format!("{name}.json.tmp"));
    let text = serde_json::to_string_pretty(value).map_err(|error| DataError::Parse {
        name: name.to_owned(),
        message: error.to_string(),
    })?;
    fs::write(&temp, text).map_err(|error| io_error(&temp, error))?;
    fs::rename(&temp, &path).map_err(|error| io_error(&path, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("jarvis-data-{label}-{nanos}"))
    }

    #[test]
    fn rejects_names_outside_the_allowlist() {
        let dir = temp_dir("allowlist");
        assert!(matches!(
            read(&dir, "../secrets"),
            Err(DataError::NotAllowed(_))
        ));
        assert!(matches!(
            write(&dir, "reminders", &json!({})),
            Err(DataError::NotAllowed(_))
        ));
    }

    #[test]
    fn missing_document_reads_as_none() {
        let dir = temp_dir("missing");
        assert!(matches!(read(&dir, "memory"), Ok(None)));
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = temp_dir("roundtrip");
        let value = json!({ "notes": { "wifi": { "value": "home" } } });
        write(&dir, "memory", &value).expect("write");
        assert_eq!(read(&dir, "memory").expect("read"), Some(value));
        assert!(!dir.join("memory.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_document_is_an_error_not_an_empty_value() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join("goals.json"), "{ not json").expect("seed");
        assert!(matches!(read(&dir, "goals"), Err(DataError::Parse { .. })));
        let _ = fs::remove_dir_all(&dir);
    }
}
