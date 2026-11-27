//! JARVIS desktop backend.
//!
//! The backend owns everything that must keep running while the window is
//! hidden (microphone, wake word, global shortcut, tray) and every call into
//! the operating system. OS-specific code lives only in [`platform`].

pub mod audio;
pub mod commands;
pub mod data;
pub mod legacy_import;
pub mod platform;
pub mod reminders;
pub mod rules;
pub mod secrets;
pub mod shell;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(audio::AudioService::new())
        .manage(shell::VoiceShortcut::default())
        // Closing the window only hides it: JARVIS keeps listening until the
        // user quits from the tray.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let data_dir = data::DataDir(app.path().app_data_dir()?);
            let reminders = Arc::new(reminders::Reminders::load(data_dir.clone())?);
            app.manage(data_dir.clone());
            app.manage(Arc::clone(&reminders));
            reminders::spawn_scheduler(app.handle().clone(), reminders, data_dir);
            shell::setup_tray(app)?;
            shell::register_voice_shortcut(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platform_info,
            commands::open_app,
            commands::open_privacy_settings,
            commands::audio_start,
            commands::audio_stop,
            commands::audio_stream_start,
            commands::audio_stream_stop,
            commands::audio_configure_wake_word,
            commands::secret_get,
            commands::secret_set,
            commands::secret_delete,
            commands::voice_shortcut_set,
            commands::data_read,
            commands::data_write,
            commands::reminder_add,
            commands::reminder_list,
            commands::reminder_cancel,
            commands::app_quit,
            commands::legacy_import_keys,
            commands::legacy_read_document,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the JARVIS application")
        .run(|app, event| {
            if platform::is_dock_reopen(&event) {
                shell::show_main_window(app);
            }
        });
}
