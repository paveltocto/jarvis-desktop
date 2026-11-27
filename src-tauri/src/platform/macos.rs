//! macOS implementation (v1 target).
//!
//! Features are added phase by phase (see docs/MIGRATION_PLAN.md). Until a
//! method is overridden here it reports `Unsupported`, and the matching
//! capability must not be listed.

use super::{Capability, Platform, PlatformError, PrivacyPane, Result, validate_app_name};
use std::path::Path;
use std::process::Command;
use trash::macos::{DeleteMethod, TrashContextExtMacos};

pub struct MacosPlatform;

impl Platform for MacosPlatform {
    fn capabilities(&self) -> Vec<Capability> {
        vec![
            Capability::OpenApp,
            Capability::PrivacySettings,
            Capability::Trash,
        ]
    }

    /// Uses `NSFileManager`, which needs no Automation permission (the
    /// default asks Finder through AppleScript).
    fn move_to_trash(&self, path: &Path) -> Result<()> {
        let mut context = trash::TrashContext::default();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(path).map_err(|error| PlatformError::Failed {
            message: format!("could not move to the Trash: {error}"),
        })
    }

    /// `open -a` resolves names through Launch Services, case-insensitively
    /// ("safari", "Visual Studio Code").
    fn open_app(&self, name: &str) -> Result<()> {
        let name = validate_app_name(name)?;
        run("open", &["-a", name])
    }

    fn open_privacy_settings(&self, pane: PrivacyPane) -> Result<()> {
        let anchor = match pane {
            PrivacyPane::Microphone => "Privacy_Microphone",
            PrivacyPane::Accessibility => "Privacy_Accessibility",
            PrivacyPane::ScreenRecording => "Privacy_ScreenCapture",
            PrivacyPane::Camera => "Privacy_Camera",
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        run("open", &[&url])
    }
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let output =
        Command::new(program)
            .args(args)
            .output()
            .map_err(|error| PlatformError::Failed {
                message: format!("could not run {program}: {error}"),
            })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(PlatformError::Failed {
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}
