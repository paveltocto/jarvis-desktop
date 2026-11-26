import { invoke } from "@tauri-apps/api/core";

/** Operating system families reported by the Rust platform layer. */
export type Os = "macos" | "windows" | "linux" | "other";

/** Mirrors `platform::Capability` in `src-tauri/src/platform/mod.rs`. */
export type Capability =
  | "volume"
  | "brightness"
  | "open_app"
  | "list_apps"
  | "windows"
  | "ui_scripting"
  | "shell"
  | "do_not_disturb"
  | "power_mode"
  | "reveal_in_file_manager"
  | "privacy_settings";

/** Mirrors `platform::PlatformInfo`. */
export interface PlatformInfo {
  os: Os;
  arch: string;
  capabilities: Capability[];
}

export function getPlatformInfo(): Promise<PlatformInfo> {
  return invoke<PlatformInfo>("platform_info");
}
