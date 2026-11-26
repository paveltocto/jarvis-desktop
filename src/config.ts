/**
 * User settings for phase 1, stored in localStorage. Moves to the Rust
 * settings store in phase 2.
 */

import type { Os } from "./platform";

export type ActivationMode = "wake_word" | "push_to_talk" | "always_on";

export interface Settings {
  activationMode: ActivationMode;
  /** Wake-word score needed to trigger, `0.05..0.99`. Lower is more sensitive. */
  wakeWordThreshold: number;
  /** Gemini prebuilt voice name. */
  voice: string;
  liveModel: string;
  /** Close the session after this much silence (wake word and push-to-talk modes). */
  inactivityTimeoutMs: number;
  /** Global push-to-talk / wake shortcut, one of `VOICE_SHORTCUTS`. */
  voiceShortcut: string;
}

/**
 * Shortcuts offered in Settings, as Tauri accelerators. Must match `PRESETS`
 * in `src-tauri/src/shell.rs`. Option+Space is not the default because
 * Gemini and ChatGPT for Mac claim it, and macOS fires every app registered
 * for the same combination.
 */
export const VOICE_SHORTCUTS = [
  { accelerator: "Control+Alt+Space", mac: "⌃⌥ Space", other: "Ctrl+Alt+Space" },
  { accelerator: "Alt+Space", mac: "⌥ Space", other: "Alt+Space" },
  { accelerator: "Shift+Alt+Space", mac: "⇧⌥ Space", other: "Shift+Alt+Space" },
  { accelerator: "Control+Shift+Space", mac: "⌃⇧ Space", other: "Ctrl+Shift+Space" },
  { accelerator: "CommandOrControl+Shift+J", mac: "⌘⇧ J", other: "Ctrl+Shift+J" },
] as const;

/** Must match `DEFAULT_VOICE_SHORTCUT` in `src-tauri/src/shell.rs`. */
export const DEFAULT_VOICE_SHORTCUT = "Control+Alt+Space";

/** Human-readable label for a shortcut accelerator on the given OS. */
export function shortcutLabel(accelerator: string, os: Os): string {
  const preset = VOICE_SHORTCUTS.find((item) => item.accelerator === accelerator);
  if (!preset) return accelerator;
  return os === "macos" ? preset.mac : preset.other;
}

/** Default model carried over from the legacy app. */
export const DEFAULT_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

/** Voices offered by the legacy app. */
export const VOICES = [
  "Aoede",
  "Kore",
  "Leda",
  "Zephyr",
  "Charon",
  "Puck",
  "Fenrir",
  "Orus",
] as const;

export const DEFAULT_SETTINGS: Settings = {
  activationMode: "wake_word",
  wakeWordThreshold: 0.5,
  voice: "Aoede",
  liveModel: DEFAULT_LIVE_MODEL,
  inactivityTimeoutMs: 12_000,
  voiceShortcut: DEFAULT_VOICE_SHORTCUT,
};

const STORAGE_KEY = "jarvis.settings.v1";
const MODES: readonly ActivationMode[] = ["wake_word", "push_to_talk", "always_on"];

/** Merges stored values over the defaults, dropping anything invalid. */
export function parseSettings(raw: unknown): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null) return settings;
  const value = raw as Record<string, unknown>;
  if (MODES.includes(value.activationMode as ActivationMode)) {
    settings.activationMode = value.activationMode as ActivationMode;
  }
  if (typeof value.wakeWordThreshold === "number" && Number.isFinite(value.wakeWordThreshold)) {
    settings.wakeWordThreshold = Math.min(0.99, Math.max(0.05, value.wakeWordThreshold));
  }
  if (typeof value.voice === "string" && (VOICES as readonly string[]).includes(value.voice)) {
    settings.voice = value.voice;
  }
  if (typeof value.liveModel === "string" && value.liveModel.trim()) {
    settings.liveModel = value.liveModel.trim();
  }
  if (typeof value.inactivityTimeoutMs === "number" && value.inactivityTimeoutMs >= 3_000) {
    settings.inactivityTimeoutMs = Math.min(120_000, value.inactivityTimeoutMs);
  }
  if (VOICE_SHORTCUTS.some((item) => item.accelerator === value.voiceShortcut)) {
    settings.voiceShortcut = value.voiceShortcut as string;
  }
  return settings;
}

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return parseSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable; settings then last for this run only.
  }
}
