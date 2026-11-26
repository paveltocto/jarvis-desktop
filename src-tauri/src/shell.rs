//! Desktop shell: tray menu, global voice shortcut and window helpers.

use serde::Serialize;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Default push-to-talk / wake shortcut (Control+Option+Space on macOS).
/// Option+Space is avoided: Gemini and ChatGPT for Mac claim it by default,
/// and macOS fires every app registered for the same combination.
pub const DEFAULT_VOICE_SHORTCUT: &str = "Control+Alt+Space";

/// Frontend event names emitted by the backend.
pub mod events {
    pub const AUDIO_LEVEL: &str = "audio:level";
    pub const AUDIO_WAKE_WORD: &str = "audio:wake-word";
    pub const AUDIO_ERROR: &str = "audio:error";
    /// Payload: `"pressed"` or `"released"`.
    pub const VOICE_SHORTCUT: &str = "shortcut:voice";
    pub const TOGGLE_MUTE: &str = "tray:toggle-mute";
    pub const SHELL_ERROR: &str = "shell:error";
}

const MAIN_WINDOW: &str = "main";

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle-window", "Show/Hide JARVIS", true, None::<&str>)?;
    let mute = MenuItem::with_id(
        app,
        "toggle-mute",
        "Mute/Unmute microphone",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit JARVIS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &mute, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("JARVIS")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle-window" => toggle_main_window(app),
            "toggle-mute" => {
                let _ = app.emit(events::TOGGLE_MUTE, ());
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// The voice shortcut currently registered by JARVIS, if any.
#[derive(Default)]
pub struct VoiceShortcut(Mutex<Option<Shortcut>>);

#[derive(Debug, thiserror::Error)]
pub enum ShortcutError {
    #[error("invalid shortcut \"{0}\": {1}")]
    Invalid(String, String),
    #[error("the shortcut {0} is unavailable: {1}")]
    Unavailable(String, String),
}

impl Serialize for ShortcutError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Registers `accelerator` as the voice shortcut, replacing the previous one.
/// The previous shortcut is released only after the new one is registered,
/// so a failure leaves the old shortcut working.
pub fn set_voice_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), ShortcutError> {
    let shortcut = Shortcut::from_str(accelerator)
        .map_err(|error| ShortcutError::Invalid(accelerator.to_owned(), error.to_string()))?;
    let state = app.state::<VoiceShortcut>();
    let mut current = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *current == Some(shortcut) {
        return Ok(());
    }
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            let state = match event.state {
                ShortcutState::Pressed => "pressed",
                ShortcutState::Released => "released",
            };
            let _ = app.emit(events::VOICE_SHORTCUT, state);
        })
        .map_err(|error| ShortcutError::Unavailable(accelerator.to_owned(), error.to_string()))?;
    if let Some(previous) = current.replace(shortcut)
        && let Err(error) = app.global_shortcut().unregister(previous)
    {
        log::warn!("could not unregister the previous voice shortcut: {error}");
    }
    Ok(())
}

/// Registers the default voice shortcut at startup. Failure (for example the
/// combination is taken by another app) is reported to the frontend instead
/// of aborting.
pub fn register_voice_shortcut(app: &AppHandle) {
    if let Err(error) = set_voice_shortcut(app, DEFAULT_VOICE_SHORTCUT) {
        log::warn!("{error}");
        let _ = app.emit(events::SHELL_ERROR, error.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Must match `VOICE_SHORTCUTS` in `src/config.ts`.
    const PRESETS: &[&str] = &[
        "Control+Alt+Space",
        "Alt+Space",
        "Shift+Alt+Space",
        "Control+Shift+Space",
        "CommandOrControl+Shift+J",
    ];

    #[test]
    fn presets_parse() {
        for preset in PRESETS {
            assert!(
                Shortcut::from_str(preset).is_ok(),
                "{preset} does not parse"
            );
        }
    }

    #[test]
    fn default_is_a_preset() {
        assert!(PRESETS.contains(&DEFAULT_VOICE_SHORTCUT));
    }

    #[test]
    fn invalid_accelerator_is_rejected() {
        assert!(Shortcut::from_str("Hyper+Banana").is_err());
    }
}
