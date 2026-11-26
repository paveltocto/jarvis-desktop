//! Tauri commands exposed to the frontend.
//!
//! Commands stay thin: they validate input, call into a service or the
//! platform layer, and map errors into a serializable form.

use crate::platform::{self, PlatformInfo};

/// Returns the current OS, architecture and the capabilities the platform
/// layer implements. The frontend uses this to decide which tools to offer
/// to the model.
#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    platform::current().info()
}
