//! Tauri commands exposed to the frontend.
//!
//! Commands stay thin: they validate input, call into a service or the
//! platform layer, and map errors into a serializable form. Commands that
//! can block (devices, Keychain, processes) are `async` so they run off the
//! main thread.

use crate::audio::{AudioError, AudioEvents, AudioService, InputDeviceInfo};
use crate::data::{self, DataDir, DataError};
use crate::legacy_import;
use crate::platform::{self, PlatformError, PlatformInfo, PrivacyPane};
use crate::reminders::{self, Reminder, ReminderError, Reminders};
use crate::secrets::{self, SecretError};
use crate::shell::{self, ShortcutError, events};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

/// Returns the current OS, architecture and the capabilities the platform
/// layer implements. The frontend uses this to decide which tools to offer
/// to the model.
#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    platform::current().info()
}

#[tauri::command]
pub async fn open_app(name: String) -> Result<(), PlatformError> {
    platform::current().open_app(&name)
}

#[tauri::command]
pub async fn open_privacy_settings(pane: PrivacyPane) -> Result<(), PlatformError> {
    platform::current().open_privacy_settings(pane)
}

/// Forwards audio events to the webview.
struct WebviewAudioEvents(AppHandle);

impl AudioEvents for WebviewAudioEvents {
    fn level(&self, rms: f32) {
        let _ = self.0.emit(events::AUDIO_LEVEL, rms);
    }
    fn wake_word(&self, score: f32) {
        let _ = self.0.emit(events::AUDIO_WAKE_WORD, score);
    }
    fn error(&self, message: String) {
        log::warn!("{message}");
        let _ = self.0.emit(events::AUDIO_ERROR, message);
    }
}

/// Opens the microphone. On macOS the first call triggers the system
/// permission prompt.
#[tauri::command]
pub async fn audio_start(
    app: AppHandle,
    audio: State<'_, AudioService>,
) -> Result<InputDeviceInfo, AudioError> {
    audio.start(Arc::new(WebviewAudioEvents(app)))
}

#[tauri::command]
pub async fn audio_stop(audio: State<'_, AudioService>) -> Result<(), AudioError> {
    audio.stop();
    Ok(())
}

/// Streams 16 kHz mono PCM16 (little-endian) to `on_audio` until
/// `audio_stream_stop`.
#[tauri::command]
pub fn audio_stream_start(audio: State<'_, AudioService>, on_audio: Channel<InvokeResponseBody>) {
    audio.start_stream(on_audio);
}

#[tauri::command]
pub fn audio_stream_stop(audio: State<'_, AudioService>) {
    audio.stop_stream();
}

#[tauri::command]
pub fn audio_configure_wake_word(audio: State<'_, AudioService>, enabled: bool, threshold: f32) {
    audio.configure_wake_word(enabled, threshold);
}

#[tauri::command]
pub async fn secret_get(name: String) -> Result<Option<String>, SecretError> {
    secrets::get(&name)
}

#[tauri::command]
pub async fn secret_set(name: String, value: String) -> Result<(), SecretError> {
    secrets::set(&name, &value)
}

#[tauri::command]
pub async fn secret_delete(name: String) -> Result<(), SecretError> {
    secrets::delete(&name)
}

/// Reads a JSON document (memory, profile, goals, protocols). `null` when
/// the document has not been written yet.
#[tauri::command]
pub async fn data_read(
    dir: State<'_, DataDir>,
    name: String,
) -> Result<Option<serde_json::Value>, DataError> {
    data::read(&dir.0, &name)
}

#[tauri::command]
pub async fn data_write(
    dir: State<'_, DataDir>,
    name: String,
    value: serde_json::Value,
) -> Result<(), DataError> {
    data::write(&dir.0, &name, &value)
}

#[tauri::command]
pub async fn reminder_add(
    reminders: State<'_, Arc<Reminders>>,
    message: String,
    due_at_ms: i64,
) -> Result<Reminder, ReminderError> {
    reminders.add(&message, due_at_ms, reminders::now_ms())
}

#[tauri::command]
pub async fn reminder_list(
    reminders: State<'_, Arc<Reminders>>,
) -> Result<Vec<Reminder>, ReminderError> {
    reminders.list()
}

#[tauri::command]
pub async fn reminder_cancel(
    reminders: State<'_, Arc<Reminders>>,
    id: String,
) -> Result<bool, ReminderError> {
    reminders.cancel(&id)
}

/// Quits the app. The frontend only calls this after the user confirmed in the window.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// Asks the user to pick the legacy api_keys.json and stores its keys.
/// `None` when the user cancels. Returns key names only, never values.
/// Async so it runs off the main thread: the picker blocks until the user
/// answers, and blocking the main thread would freeze the picker itself.
#[tauri::command]
pub async fn legacy_import_keys(
    app: AppHandle,
) -> Result<Option<legacy_import::ImportReport>, legacy_import::ImportError> {
    legacy_import::pick_and_import_keys(&app)
}

/// Asks the user to pick a legacy JSON file (memory or protocols) and returns its content.
/// `None` when the user cancels. Async for the same reason as `legacy_import_keys`.
#[tauri::command]
pub async fn legacy_read_document(
    app: AppHandle,
) -> Result<Option<serde_json::Value>, legacy_import::ImportError> {
    legacy_import::pick_and_read_json(&app)
}

/// Replaces the global voice shortcut. Synchronous so it runs on the main
/// thread, which macOS requires for hotkey registration.
#[tauri::command]
pub fn voice_shortcut_set(app: AppHandle, accelerator: String) -> Result<(), ShortcutError> {
    shell::set_voice_shortcut(&app, &accelerator)
}
