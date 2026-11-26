/**
 * Typed access to the Rust backend: commands and events. The command and
 * event names must match `src-tauri/src/commands.rs` and `shell.rs`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

export const shell = {
  /** Replaces the global voice shortcut; rejects and keeps the old one on failure. */
  setVoiceShortcut: (accelerator: string) =>
    invoke<undefined>("voice_shortcut_set", { accelerator }),
};

export const events = {
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
