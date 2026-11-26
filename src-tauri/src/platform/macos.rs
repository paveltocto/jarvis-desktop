//! macOS implementation (v1 target).
//!
//! Features are added phase by phase (see docs/MIGRATION_PLAN.md). Until a
//! method is overridden here it reports `Unsupported`, and the matching
//! capability must not be listed.

use super::Platform;

pub struct MacosPlatform;

impl Platform for MacosPlatform {}
