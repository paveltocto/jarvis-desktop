//! One-time import of the legacy `config/api_keys.json` into the Keychain.
//!
//! The file is read here, never in the webview. Only keys listed in
//! [`MAPPING`] are stored, and only when they hold a real value. The report
//! names the keys, never their values, so nothing secret reaches the
//! frontend or the logs.

use crate::secrets::{self, SecretError};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// The api_keys.json file is a few hundred bytes.
const MAX_KEYS_BYTES: u64 = 64 * 1024;
/// Memory and protocol files are far smaller than this in practice.
const MAX_DOCUMENT_BYTES: u64 = 1024 * 1024;

/// Legacy key name and the Keychain name it becomes. Add a row when a
/// provider is ported; the secrets allowlist must list the Keychain name too.
const MAPPING: &[(&str, &str)] = &[("gemini_api_key", "gemini_api_key")];

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("could not read the file: {0}")]
    Read(String),
    #[error("the file is too large to be a JARVIS file")]
    TooLarge,
    #[error("the file is not valid JSON: {0}")]
    NotJson(String),
    #[error("the file must contain a JSON object with the keys")]
    NotAnObject,
    #[error("{0}")]
    Secret(#[from] SecretError),
}

impl Serialize for ImportError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Keychain names that were written.
    pub imported: Vec<String>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    /// Legacy key name.
    pub name: String,
    pub reason: String,
}

/// Values to store. Deliberately not `Debug`, so they cannot be logged by accident.
pub struct Plan {
    pub secrets: Vec<(&'static str, String)>,
    pub skipped: Vec<Skipped>,
}

/// Decides what to import from the JSON text. Performs no I/O.
pub fn plan(text: &str) -> Result<Plan, ImportError> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| ImportError::NotJson(e.to_string()))?;
    let object = value.as_object().ok_or(ImportError::NotAnObject)?;

    let mut secrets = Vec::new();
    let mut skipped = Vec::new();
    for (name, value) in object {
        let text = value.as_str().map(str::trim).unwrap_or_default();
        let blank = text.is_empty() || is_placeholder(text);
        match MAPPING.iter().find(|(legacy, _)| legacy == name) {
            Some((_, target)) if !blank => secrets.push((*target, text.to_owned())),
            Some(_) => skipped.push(skip(name, "empty or still the example placeholder")),
            None if !is_secret_name(name) => {}
            None if blank => skipped.push(skip(name, "empty or still the example placeholder")),
            None => skipped.push(skip(
                name,
                "not used yet; it will be imported when its feature arrives",
            )),
        }
    }
    Ok(Plan { secrets, skipped })
}

/// Keys that hold credentials. Other settings in the file are not reported.
fn is_secret_name(name: &str) -> bool {
    name.ends_with("_api_key") || name.ends_with("_token")
}

/// Example files ship values such as `YOUR_GEMINI_API_KEY_HERE`.
fn is_placeholder(text: &str) -> bool {
    text.starts_with("YOUR_") || text.ends_with("_HERE")
}

fn skip(name: &str, reason: &str) -> Skipped {
    Skipped {
        name: name.to_owned(),
        reason: reason.to_owned(),
    }
}

/// Shows the system file picker for JSON files. `None` when the user cancels.
/// The path is chosen here, so the webview never supplies a path to read.
///
/// Blocks until the user answers, so it must never run on the main thread
/// (synchronous Tauri commands do): the picker needs the main thread to run and
/// would deadlock. Call it only from async commands.
fn pick_json(app: &AppHandle) -> Result<Option<PathBuf>, ImportError> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose a JSON file from the legacy JARVIS folder")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    match picked {
        None => Ok(None),
        Some(file) => file
            .into_path()
            .map(Some)
            .map_err(|error| ImportError::Read(error.to_string())),
    }
}

/// Reads a file of at most `limit` bytes as text.
fn read_limited(path: &Path, limit: u64) -> Result<String, ImportError> {
    let metadata = std::fs::metadata(path).map_err(|e| ImportError::Read(e.to_string()))?;
    if metadata.len() > limit {
        return Err(ImportError::TooLarge);
    }
    std::fs::read_to_string(path).map_err(|e| ImportError::Read(e.to_string()))
}

/// Lets the user pick a JSON file and returns its parsed content.
/// Used for the legacy memory and protocol files; the caller decides what to do with it.
pub fn pick_and_read_json(app: &AppHandle) -> Result<Option<Value>, ImportError> {
    let Some(path) = pick_json(app)? else {
        return Ok(None);
    };
    let text = read_limited(&path, MAX_DOCUMENT_BYTES)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| ImportError::NotJson(e.to_string()))
}

/// Lets the user pick api_keys.json and stores the keys it contains.
/// `None` when the user cancels.
pub fn pick_and_import_keys(app: &AppHandle) -> Result<Option<ImportReport>, ImportError> {
    let Some(path) = pick_json(app)? else {
        return Ok(None);
    };
    import_file(&path).map(Some)
}

/// Reads the file at `path` and stores the keys it contains.
pub fn import_file(path: &Path) -> Result<ImportReport, ImportError> {
    let text = read_limited(path, MAX_KEYS_BYTES)?;
    let plan = plan(&text)?;

    let mut imported = Vec::new();
    for (name, value) in &plan.secrets {
        secrets::set(name, value)?;
        imported.push((*name).to_owned());
    }
    Ok(ImportReport {
        imported,
        skipped: plan.skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_real_values_and_skips_placeholders() {
        let plan = plan(
            r#"{
                "gemini_api_key": "AIza-real-looking-value",
                "telegram_bot_token": "123:ABC",
                "deepseek_api_key": "YOUR_DEEPSEEK_API_KEY_HERE",
                "jarvis_voice": "Charon"
            }"#,
        )
        .expect("valid file");
        assert_eq!(plan.secrets.len(), 1);
        assert_eq!(plan.secrets[0].0, "gemini_api_key");
        assert_eq!(plan.skipped.len(), 2);
        assert!(
            plan.skipped
                .iter()
                .any(|s| s.name == "telegram_bot_token" && s.reason.contains("not used yet"))
        );
        assert!(
            plan.skipped
                .iter()
                .any(|s| s.name == "deepseek_api_key" && s.reason.contains("placeholder"))
        );
    }

    #[test]
    fn treats_empty_gemini_key_as_skipped() {
        let plan = plan(r#"{"gemini_api_key": "  "}"#).expect("valid file");
        assert!(plan.secrets.is_empty());
        assert_eq!(plan.skipped[0].name, "gemini_api_key");
    }

    #[test]
    fn rejects_files_that_are_not_a_json_object() {
        assert!(matches!(plan("not json"), Err(ImportError::NotJson(_))));
        assert!(matches!(plan("[1, 2]"), Err(ImportError::NotAnObject)));
    }

    #[test]
    fn refuses_oversized_files_before_reading_them() {
        let path =
            std::env::temp_dir().join(format!("jarvis-keys-big-{}.json", std::process::id()));
        std::fs::write(&path, vec![b' '; 70 * 1024]).expect("write");
        assert!(matches!(
            read_limited(&path, MAX_KEYS_BYTES),
            Err(ImportError::TooLarge)
        ));
        let _ = std::fs::remove_file(&path);
    }
}
