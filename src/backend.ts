/**
 * Typed access to the Rust backend: commands and events. The command and
 * event names must match `src-tauri/src/commands.rs` and `shell.rs`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DocumentBackend, DocumentName } from "./data/document-store";
import type { Reminder, ReminderApi } from "./tools/types";
import type { AudioBackend } from "./voice/controller";

export interface InputDeviceInfo {
  name: string;
  sampleRate: number;
  channels: number;
}

export type PrivacyPane = "microphone" | "accessibility" | "screenRecording" | "camera";
export type SecretName = "gemini_api_key";

export const audioBackend: AudioBackend & { startAudio(): Promise<InputDeviceInfo> } = {
  startAudio: () => invoke<InputDeviceInfo>("audio_start"),
  stopAudio: () => invoke("audio_stop"),
  async startStream(onAudio) {
    const channel = new Channel<ArrayBuffer | number[]>();
    // Raw IPC payloads arrive as ArrayBuffer; accept number[] defensively.
    channel.onmessage = (data) =>
      onAudio(data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer);
    await invoke("audio_stream_start", { onAudio: channel });
  },
  stopStream: () => invoke("audio_stream_stop"),
  configureWakeWord: (enabled, threshold) =>
    invoke("audio_configure_wake_word", { enabled, threshold }),
};

export const system = {
  openApp: (name: string) => invoke<undefined>("open_app", { name }),
  openPrivacySettings: (pane: PrivacyPane) => invoke<undefined>("open_privacy_settings", { pane }),
};

export const secrets = {
  get: (name: SecretName) => invoke<string | null>("secret_get", { name }),
  set: (name: SecretName, value: string) => invoke<undefined>("secret_set", { name, value }),
  delete: (name: SecretName) => invoke<undefined>("secret_delete", { name }),
};

/** One-time import of the legacy api_keys.json. Returns names only, never values. */
export interface LegacyImportReport {
  imported: string[];
  skipped: { name: string; reason: string }[];
}

/**
 * Legacy imports. The Rust side shows the file picker, so the webview never
 * chooses a path. `null` means the user cancelled.
 */
export const legacy = {
  importKeys: () => invoke<LegacyImportReport | null>("legacy_import_keys"),
  readDocument: () => invoke<unknown | null>("legacy_read_document"),
};

export const app = {
  /** Quits JARVIS. Only call after the user confirmed. */
  quit: () => invoke<undefined>("app_quit"),
};

export const shell = {
  /** Replaces the global voice shortcut; rejects and keeps the old one on failure. */
  setVoiceShortcut: (accelerator: string) =>
    invoke<undefined>("voice_shortcut_set", { accelerator }),
};

export const documents: DocumentBackend = {
  read: (name: DocumentName) => invoke<unknown | null>("data_read", { name }),
  write: (name: DocumentName, value: unknown) => invoke<undefined>("data_write", { name, value }),
};

export const reminders: ReminderApi = {
  add: (message, dueAtMs) => invoke<Reminder>("reminder_add", { message, dueAtMs }),
  list: () => invoke<Reminder[]>("reminder_list"),
  cancel: (id) => invoke<boolean>("reminder_cancel", { id }),
};

export const events = {
  ruleDue: (handler: (due: { id: string; nextRunAtMs: number }) => void): Promise<UnlistenFn> =>
    listen<{ id: string; nextRunAtMs: number }>("rule:due", (event) => handler(event.payload)),
  reminderDue: (handler: (reminder: Reminder) => void): Promise<UnlistenFn> =>
    listen<Reminder>("reminder:due", (event) => handler(event.payload)),
  audioLevel: (handler: (rms: number) => void): Promise<UnlistenFn> =>
    listen<number>("audio:level", (event) => handler(event.payload)),
  wakeWord: (handler: (score: number) => void): Promise<UnlistenFn> =>
    listen<number>("audio:wake-word", (event) => handler(event.payload)),
  audioError: (handler: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>("audio:error", (event) => handler(event.payload)),
  voiceShortcut: (handler: (state: "pressed" | "released") => void): Promise<UnlistenFn> =>
    listen<"pressed" | "released">("shortcut:voice", (event) => handler(event.payload)),
  toggleMute: (handler: () => void): Promise<UnlistenFn> =>
    listen("tray:toggle-mute", () => handler()),
  shellError: (handler: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>("shell:error", (event) => handler(event.payload)),
};

/** Tauri rejects with the serialized Rust error: a string or an object. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error)
    return String(error.message);
  return JSON.stringify(error);
}
