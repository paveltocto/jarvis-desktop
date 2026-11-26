//! Fallback for operating systems the app does not target (for example
//! Linux, used for local development and CI). Every feature reports
//! `Unsupported`.

use super::Platform;

pub struct UnsupportedPlatform;

impl Platform for UnsupportedPlatform {}
