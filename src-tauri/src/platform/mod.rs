//! Platform abstraction layer.
//!
//! This is the only module allowed to contain `#[cfg(target_os = ...)]`
//! branches. Every other module talks to the OS through the [`Platform`]
//! trait, so adding Windows later means implementing `windows.rs` and
//! nothing else.
//!
//! Every trait method has a default implementation that returns
//! [`PlatformError::Unsupported`]. A platform opts in to a feature by
//! overriding the method *and* listing the matching [`Capability`] in
//! [`Platform::capabilities`]. Tools must never report success for a
//! feature the current platform does not support.

use serde::Serialize;
use std::path::Path;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

/// Operating system families the app knows about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Os {
    Macos,
    Windows,
    Linux,
    Other,
}

impl Os {
    /// The OS this binary was compiled for.
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// Whether `event` is a click on the Dock icon of the running app. Only macOS
/// emits it.
pub fn is_dock_reopen(event: &tauri::RunEvent) -> bool {
    #[cfg(target_os = "macos")]
    {
        matches!(event, tauri::RunEvent::Reopen { .. })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = event;
        false
    }
}

/// OS features a platform implementation can provide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Volume,
    Brightness,
    OpenApp,
    ListApps,
    Windows,
    UiScripting,
    Shell,
    DoNotDisturb,
    PowerMode,
    RevealInFileManager,
    PrivacySettings,
}

/// Summary of the running platform, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: Os,
    pub arch: &'static str,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u64,
    pub app_name: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowAction {
    Focus,
    Minimize,
    Maximize,
    Close,
}

/// System privacy panes the app may need to send the user to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyPane {
    Microphone,
    Accessibility,
    ScreenRecording,
    Camera,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerMode {
    LowPower,
    Balanced,
    HighPerformance,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlatformError {
    #[error("{feature} is not supported on {os:?}")]
    Unsupported { feature: &'static str, os: Os },
    #[error("{message}")]
    Failed { message: String },
}

pub type Result<T> = std::result::Result<T, PlatformError>;

fn unsupported<T>(feature: &'static str) -> Result<T> {
    Err(PlatformError::Unsupported {
        feature,
        os: Os::current(),
    })
}

/// OS integration surface. See the module docs for the opt-in rules.
pub trait Platform: Send + Sync {
    /// Features this implementation actually provides.
    fn capabilities(&self) -> Vec<Capability> {
        Vec::new()
    }

    fn info(&self) -> PlatformInfo {
        PlatformInfo {
            os: Os::current(),
            arch: std::env::consts::ARCH,
            capabilities: self.capabilities(),
        }
    }

    fn get_volume(&self) -> Result<u8> {
        unsupported("volume")
    }
    fn set_volume(&self, _percent: u8) -> Result<()> {
        unsupported("volume")
    }
    fn set_muted(&self, _muted: bool) -> Result<()> {
        unsupported("volume")
    }
    fn set_brightness(&self, _percent: u8) -> Result<()> {
        unsupported("brightness")
    }
    fn open_app(&self, _name: &str) -> Result<()> {
        unsupported("open_app")
    }
    fn list_apps(&self) -> Result<Vec<AppInfo>> {
        unsupported("list_apps")
    }
    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        unsupported("windows")
    }
    fn window_action(&self, _id: u64, _action: WindowAction) -> Result<()> {
        unsupported("windows")
    }
    /// Runs a UI automation script (AppleScript/JXA on macOS, UI Automation on Windows).
    fn ui_script(&self, _script: &str) -> Result<String> {
        unsupported("ui_scripting")
    }
    fn run_shell(&self, _command: &str) -> Result<ShellOutput> {
        unsupported("shell")
    }
    fn set_do_not_disturb(&self, _enabled: bool) -> Result<()> {
        unsupported("do_not_disturb")
    }
    fn set_power_mode(&self, _mode: PowerMode) -> Result<()> {
        unsupported("power_mode")
    }
    fn reveal_in_file_manager(&self, _path: &Path) -> Result<()> {
        unsupported("reveal_in_file_manager")
    }
    /// Opens the system settings page where the user grants a permission.
    fn open_privacy_settings(&self, _pane: PrivacyPane) -> Result<()> {
        unsupported("privacy_settings")
    }
}

/// Validates an application name before it reaches a system command.
// Used by the macOS implementation today and by Windows in phase 8.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn validate_app_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n', '\r']) {
        return Err(PlatformError::Failed {
            message: format!("invalid application name: {name:?}"),
        });
    }
    Ok(name)
}

/// Returns the implementation for the OS this binary was compiled for.
pub fn current() -> Box<dyn Platform> {
    #[cfg(target_os = "macos")]
    return Box::new(macos::MacosPlatform);
    #[cfg(target_os = "windows")]
    return Box::new(windows::WindowsPlatform);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Box::new(unsupported::UnsupportedPlatform);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Bare;
    impl Platform for Bare {}

    #[test]
    fn default_methods_report_unsupported() {
        let err = Bare.set_volume(50).unwrap_err();
        assert!(matches!(
            err,
            PlatformError::Unsupported {
                feature: "volume",
                ..
            }
        ));
    }

    #[test]
    fn default_platform_has_no_capabilities() {
        assert!(Bare.info().capabilities.is_empty());
    }

    #[test]
    fn current_platform_reports_its_os() {
        assert_eq!(current().info().os, Os::current());
    }

    #[test]
    fn app_names_are_validated() {
        assert_eq!(validate_app_name("  Safari ").unwrap(), "Safari");
        assert!(validate_app_name("").is_err());
        assert!(validate_app_name("-n").is_err());
        assert!(validate_app_name("Safari\nrm").is_err());
    }

    #[test]
    fn errors_serialize_with_a_kind_tag() {
        let json = serde_json::to_value(PlatformError::Unsupported {
            feature: "volume",
            os: Os::Windows,
        })
        .unwrap();
        assert_eq!(json["kind"], "unsupported");
        assert_eq!(json["os"], "windows");
    }
}
