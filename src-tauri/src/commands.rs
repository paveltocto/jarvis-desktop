//! Tauri commands exposed to the frontend.
//!
//! Commands stay thin: they validate input, call into a service or the
//! platform layer, and map errors into a serializable form. Commands that
//! can block (devices, Keychain, processes) are `async` so they run off the
//! main thread.

use crate::audio::{AudioError, AudioEvents, AudioService, InputDeviceInfo};
use crate::platform::{self, PlatformError, PlatformInfo, PrivacyPane};
use crate::secrets::{self, SecretError};
use crate::shell::events;
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
pub async fn audio_stop(audio: State<'_, AudioService>) -> Result<(), ()> {
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
