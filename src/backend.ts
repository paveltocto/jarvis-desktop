/**
 * Typed access to the Rust backend: commands and events. The command and
 * event names must match `src-tauri/src/commands.rs` and `shell.rs`.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DocumentBackend, DocumentName } from "./data/document-store";
import type { ServiceSecret } from "./settings/services";
import type {
  AccountsApi,
  BrowserRequest,
  FilesApi,
  GoogleAccount,
  ProcessSort,
  ReadableSecret,
  Reminder,
  ReminderApi,
  SystemStats,
} from "./tools/types";
import type { AudioBackend } from "./voice/controller";

export interface InputDeviceInfo {
  name: string;
  sampleRate: number;
  channels: number;
}

export type PrivacyPane = "microphone" | "accessibility" | "screenRecording" | "camera";
/** Mirrors the allowlists in `secrets.rs`. */
export type SecretName = ReadableSecret | ServiceSecret;

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
  stats: (sort: ProcessSort, processCount: number) =>
    invoke<SystemStats>("system_stats", { sort, processCount }),
};

export const web = {
  youtubeSearch: (query: string) => invoke<string | null>("youtube_search", { query }),
  browser: (request: BrowserRequest) => invoke<string>("browser_run", { request }),
};

export const files: FilesApi = {
  query: (query) => invoke<string>("files_query", { query }),
  change: (change) => invoke<string>("files_change", { change }),
};

export const accounts: AccountsApi & {
  spotifyStatus(): Promise<{ configured: boolean; connected: boolean }>;
  spotifyConnect(): Promise<undefined>;
  spotifyDisconnect(): Promise<undefined>;
  /** Adds an account, or signs one in again when `loginHint` is its email. */
  googleConnect(loginHint: string | null): Promise<{ account: GoogleAccount; isNew: boolean }>;
  googleDisconnect(id: string): Promise<undefined>;
  googleUpdate(id: string, alias: string | null, makeDefault: boolean): Promise<undefined>;
} = {
  accessToken: (provider, accountId) =>
    invoke<string>("oauth_access_token", { provider, account: accountId ?? null }),
  googleAccounts: () => invoke<GoogleAccount[]>("google_accounts"),
  spotifyStatus: () => invoke("spotify_status"),
  spotifyConnect: () => invoke<undefined>("spotify_connect"),
  spotifyDisconnect: () => invoke<undefined>("spotify_disconnect"),
  googleConnect: (loginHint) => invoke("google_connect", { loginHint }),
  googleDisconnect: (id) => invoke<undefined>("google_disconnect", { id }),
  googleUpdate: (id, alias, makeDefault) =>
    invoke<undefined>("google_account_update", { id, alias, makeDefault }),
};

export const messaging = {
  telegram: async (text: string) => {
    await invoke("telegram_send", { text });
  },
};

export const secrets = {
  get: (name: ReadableSecret) => invoke<string | null>("secret_get", { name }),
  exists: (name: SecretName) => invoke<boolean>("secret_exists", { name }),
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
  telegramMessage: (handler: (text: string) => void): Promise<UnlistenFn> =>
    listen<string>("telegram:message", (event) => handler(event.payload)),
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
