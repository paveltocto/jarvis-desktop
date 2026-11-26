//! Desktop shell: tray menu, global voice shortcut and window helpers.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Default push-to-talk / wake shortcut (Option+Space on macOS).
pub const DEFAULT_VOICE_SHORTCUT: &str = "Alt+Space";

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

/// Registers the voice shortcut. Failure (for example the combination is
/// taken by another app) is reported to the frontend instead of aborting.
pub fn register_voice_shortcut(app: &AppHandle) {
    let result =
        app.global_shortcut()
            .on_shortcut(DEFAULT_VOICE_SHORTCUT, |app, _shortcut, event| {
                let state = match event.state {
                    ShortcutState::Pressed => "pressed",
                    ShortcutState::Released => "released",
                };
                let _ = app.emit(events::VOICE_SHORTCUT, state);
            });
    if let Err(error) = result {
        log::warn!("could not register {DEFAULT_VOICE_SHORTCUT}: {error}");
        let _ = app.emit(
            events::SHELL_ERROR,
            format!("The shortcut {DEFAULT_VOICE_SHORTCUT} is unavailable: {error}"),
        );
    }
}
