//! Reminders and the scheduler that fires them.
//!
//! The scheduler runs in Rust so reminders still fire while the window is
//! hidden: macOS throttles JavaScript timers in hidden windows. The reminder
//! list is stored in `reminders.json` and written only by this module.

use crate::data::{self, DataDir, DataError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// Frontend event. Payload: [`Reminder`].
pub const EVENT_DUE: &str = "reminder:due";

/// How often the scheduler checks for due reminders.
const TICK: Duration = Duration::from_secs(15);
/// Upper bound on stored reminders, so the file stays small.
pub const MAX_REMINDERS: usize = 200;
const MAX_MESSAGE_CHARS: usize = 500;
const DOCUMENT: &str = "reminders";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub message: String,
    /// Unix time in milliseconds.
    pub due_at_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ReminderError {
    #[error("the reminder message must not be empty")]
    EmptyMessage,
    #[error("the reminder message is longer than {MAX_MESSAGE_CHARS} characters")]
    MessageTooLong,
    #[error("the reminder time is in the past")]
    InThePast,
    #[error("there are already {MAX_REMINDERS} reminders; cancel some first")]
    TooMany,
    #[error("{0}")]
    Storage(#[from] DataError),
    #[error("the reminder list is unavailable")]
    Poisoned,
}

impl Serialize for ReminderError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Owns the reminder list. Every change is written to disk before it is
/// reported as done.
pub struct Reminders {
    dir: PathBuf,
    items: Mutex<Vec<Reminder>>,
}

impl Reminders {
    pub fn load(dir: DataDir) -> Result<Self, ReminderError> {
        let items = match data::read_any(&dir.0, DOCUMENT)? {
            Some(value) => serde_json::from_value(value).map_err(|error| DataError::Parse {
                name: DOCUMENT.to_owned(),
                message: error.to_string(),
            })?,
            None => Vec::new(),
        };
        Ok(Self {
            dir: dir.0,
            items: Mutex::new(items),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Vec<Reminder>>, ReminderError> {
        self.items.lock().map_err(|_| ReminderError::Poisoned)
    }

    fn persist(&self, items: &[Reminder]) -> Result<(), ReminderError> {
        let value = serde_json::to_value(items).map_err(|error| DataError::Parse {
            name: DOCUMENT.to_owned(),
            message: error.to_string(),
        })?;
        data::write_any(&self.dir, DOCUMENT, &value)?;
        Ok(())
    }

    pub fn add(
        &self,
        message: &str,
        due_at_ms: i64,
        now_ms: i64,
    ) -> Result<Reminder, ReminderError> {
        let message = message.trim();
        if message.is_empty() {
            return Err(ReminderError::EmptyMessage);
        }
        if message.chars().count() > MAX_MESSAGE_CHARS {
            return Err(ReminderError::MessageTooLong);
        }
        if due_at_ms <= now_ms {
            return Err(ReminderError::InThePast);
        }
        let mut items = self.lock()?;
        if items.len() >= MAX_REMINDERS {
            return Err(ReminderError::TooMany);
        }
        let reminder = Reminder {
            id: format!("r{now_ms}-{}", items.len()),
            message: message.to_owned(),
            due_at_ms,
        };
        items.push(reminder.clone());
        items.sort_by_key(|item| item.due_at_ms);
        if let Err(error) = self.persist(&items) {
            items.retain(|item| item.id != reminder.id);
            return Err(error);
        }
        Ok(reminder)
    }

    /// Pending reminders, soonest first.
    pub fn list(&self) -> Result<Vec<Reminder>, ReminderError> {
        Ok(self.lock()?.clone())
    }

    /// Removes a reminder. Returns `false` when no reminder has that id.
    pub fn cancel(&self, id: &str) -> Result<bool, ReminderError> {
        let mut items = self.lock()?;
        let before = items.len();
        let removed: Vec<Reminder> = items.iter().filter(|item| item.id == id).cloned().collect();
        items.retain(|item| item.id != id);
        if items.len() == before {
            return Ok(false);
        }
        if let Err(error) = self.persist(&items) {
            items.extend(removed);
            items.sort_by_key(|item| item.due_at_ms);
            return Err(error);
        }
        Ok(true)
    }

    /// Removes and returns every reminder due at `now_ms`.
    pub fn take_due(&self, now_ms: i64) -> Result<Vec<Reminder>, ReminderError> {
        let mut items = self.lock()?;
        let (due, pending): (Vec<Reminder>, Vec<Reminder>) = items
            .iter()
            .cloned()
            .partition(|item| item.due_at_ms <= now_ms);
        if due.is_empty() {
            return Ok(due);
        }
        let previous = std::mem::replace(&mut *items, pending);
        if let Err(error) = self.persist(&items) {
            *items = previous;
            return Err(error);
        }
        Ok(due)
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Starts the background thread that fires due reminders. The thread only
/// emits events; the webview decides how to tell the user.
pub fn spawn_scheduler(app: AppHandle, reminders: std::sync::Arc<Reminders>, dir: DataDir) {
    std::thread::Builder::new()
        .name("reminder-scheduler".into())
        .spawn(move || {
            let mut fired_rules = std::collections::HashMap::new();
            loop {
                std::thread::sleep(TICK);
                match reminders.take_due(now_ms()) {
                    Ok(due) => {
                        for reminder in due {
                            crate::shell::show_main_window(&app);
                            let _ = app.emit(EVENT_DUE, &reminder);
                        }
                    }
                    Err(error) => log::warn!("reminder scheduler: {error}"),
                }
                match crate::rules::load(&dir) {
                    Ok(document) => {
                        for due in crate::rules::due(&document, now_ms(), &mut fired_rules) {
                            let _ = app.emit(crate::rules::EVENT_DUE, &due);
                        }
                    }
                    Err(error) => log::warn!("rules scheduler: {error}"),
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|error| log::error!("could not start reminder scheduler: {error}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!("jarvis-reminders-{label}-{nanos}"))
    }

    const NOW: i64 = 1_000_000;

    #[test]
    fn rejects_empty_past_and_long_messages() {
        let reminders = Reminders::load(DataDir(temp_dir("validate"))).expect("load");
        assert!(matches!(
            reminders.add("  ", NOW + 1, NOW),
            Err(ReminderError::EmptyMessage)
        ));
        assert!(matches!(
            reminders.add("x", NOW, NOW),
            Err(ReminderError::InThePast)
        ));
        let long = "x".repeat(MAX_MESSAGE_CHARS + 1);
        assert!(matches!(
            reminders.add(&long, NOW + 1, NOW),
            Err(ReminderError::MessageTooLong)
        ));
    }

    #[test]
    fn take_due_returns_only_due_items_and_removes_them() {
        let dir = temp_dir("due");
        let reminders = Reminders::load(DataDir(dir.clone())).expect("load");
        reminders.add("later", NOW + 5_000, NOW).expect("add");
        reminders.add("soon", NOW + 1_000, NOW).expect("add");

        let due = reminders.take_due(NOW + 2_000).expect("take");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].message, "soon");
        assert_eq!(reminders.list().expect("list").len(), 1);
        assert!(reminders.take_due(NOW + 2_000).expect("take").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn survives_a_restart() {
        let dir = temp_dir("restart");
        {
            let reminders = Reminders::load(DataDir(dir.clone())).expect("load");
            reminders.add("buy milk", NOW + 1_000, NOW).expect("add");
        }
        let reloaded = Reminders::load(DataDir(dir.clone())).expect("reload");
        let items = reloaded.list().expect("list");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].message, "buy milk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_reports_whether_the_id_existed() {
        let dir = temp_dir("cancel");
        let reminders = Reminders::load(DataDir(dir.clone())).expect("load");
        let added = reminders.add("call", NOW + 1_000, NOW).expect("add");
        assert!(!reminders.cancel("missing").expect("cancel"));
        assert!(reminders.cancel(&added.id).expect("cancel"));
        assert!(reminders.list().expect("list").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
