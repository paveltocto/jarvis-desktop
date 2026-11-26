//! JARVIS desktop backend.
//!
//! The backend owns everything that must keep running while the window is
//! hidden (microphone, wake word, global shortcut, tray) and every call into
//! the operating system. OS-specific code lives only in [`platform`].

pub mod audio;
pub mod commands;
pub mod platform;
pub mod secrets;
pub mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first: a second launch focuses the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            shell::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(audio::AudioService::new())
        .setup(|app| {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running the JARVIS application");
}
