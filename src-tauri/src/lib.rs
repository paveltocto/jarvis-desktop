//! JARVIS desktop backend.
//!
//! The backend owns everything that must keep running while the window is
//! hidden (microphone, wake word, scheduler, rules, Telegram) and every call
//! into the operating system. OS-specific code lives only in [`platform`].

pub mod commands;
pub mod platform;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![commands::platform_info])
        .run(tauri::generate_context!())
        .expect("error while running the JARVIS application");
}
