//! Windows implementation.
//!
//! Intentionally empty until phase 8 of docs/MIGRATION_PLAN.md: every method
//! reports `Unsupported`. It still compiles in CI so the Windows build never
//! breaks while macOS is being developed.

use super::Platform;

pub struct WindowsPlatform;

impl Platform for WindowsPlatform {}
