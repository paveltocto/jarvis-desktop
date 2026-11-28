import type { DocumentStore } from "../data/document-store";
import type { Rule } from "../rules/model";
import { InvalidInput } from "../data/records";
import type { Capability, Os } from "../platform";

/**
 * JSON Schema subset accepted by Gemini function declarations.
 * Kept minimal on purpose; extend it when a tool needs more.
 */
export type JsonSchema =
  | { type: "string"; description?: string; enum?: readonly string[] }
  | { type: "number" | "integer" | "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchema }
  | {
      type: "object";
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: readonly string[];
    };

export type ToolErrorCode = "unknown_tool" | "unsupported" | "invalid_arguments" | "failed";

/**
 * Result of a tool call. Tools must return `ok: false` when they could not
 * do the work. Never report success for something that did not happen.
 */
export type ToolResult =
  { ok: true; output: string } | { ok: false; code: ToolErrorCode; error: string };

/** OS operations implemented by the Rust backend. */
export interface SystemApi {
  openApp(name: string): Promise<void>;
  stats(sort: ProcessSort, processCount: number): Promise<SystemStats>;
}

export type ProcessSort = "cpu" | "memory";

/** Mirrors `services::system_stats::SystemStats`. */
export interface SystemStats {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  disks: { mountPoint: string; totalBytes: number; freeBytes: number }[];
  processes: { name: string; cpuPercent: number; memoryBytes: number }[];
}

/** Mirrors `services::browser::Request`. */
export type BrowserRequest =
  | { action: "go_to"; url: string }
  | { action: "search"; query: string }
  | { action: "new_tab"; url?: string }
  | { action: "close_tab" }
  | { action: "scroll"; direction: "up" | "down" }
  | { action: "read" };

export interface WebApi {
  /** Opens a web or mail link in the user's default app. */
  openUrl(url: string): Promise<void>;
  /** URL of the first video for the search, or `null` when none was found. */
  youtubeSearch(query: string): Promise<string | null>;
  /** The browser window JARVIS controls. */
  browser(request: BrowserRequest): Promise<string>;
}

/** Mirrors `files::Query`. */
export type FileQuery =
  | { action: "list" | "read" | "info" | "duplicates"; path: string }
  | { action: "find"; path: string; name?: string; extension?: string }
  | { action: "largest"; path: string; count?: number };

/** Mirrors `files::Change`. */
export type FileChange =
  | { action: "create_folder" | "delete" | "open" | "organize"; path: string }
  | { action: "write"; path: string; content: string; overwrite: boolean }
  | {
      action: "edit";
      path: string;
      mode: "replace" | "append" | "prepend";
      oldText?: string;
      newText: string;
    }
  | { action: "move" | "copy"; path: string; destination: string }
  | { action: "rename"; path: string; newName: string }
  | { action: "create_document"; fileName: string; dataBase64: string };

/** Files in Desktop, Documents and Downloads (`files.rs`). */
export interface FilesApi {
  query(query: FileQuery): Promise<string>;
  /** Rust asks the user in a native dialog and rejects when they decline. */
  change(change: FileChange): Promise<string>;
}

/** Secrets the webview may read; mirrors `READABLE` in `secrets.rs`. */
export type ReadableSecret =
  "gemini_api_key" | "openrouter_api_key" | "deepseek_api_key" | "discord_webhook_url";

export type OAuthProvider = "google" | "spotify";

/** Mirrors `google_accounts::AccountView`. */
export interface GoogleAccount {
  id: string;
  email: string;
  /** The user's short name for it, such as "work". */
  alias: string | null;
  /** Used for sending and creating when no account is named. */
  isDefault: boolean;
  mailRead: boolean;
  mailSend: boolean;
  calendar: boolean;
}

export interface AccountsApi {
  /**
   * A short-lived access token. Google needs the account's id. Rejects when
   * the account is not connected.
   */
  accessToken(provider: OAuthProvider, accountId?: string): Promise<string>;
  googleAccounts(): Promise<GoogleAccount[]>;
}

export interface MessagingApi {
  /** Sends to the user's own Telegram chat. Ask the user first. */
  telegram(text: string): Promise<void>;
}

/** Something that leaves the machine or changes an account, waiting for the user. */
export interface Approval {
  /** The question, with everything the user needs to decide. */
  title: string;
  detail: string;
  confirmLabel: string;
  /** Runs only after the user confirms. Resolves with what happened. */
  run(): Promise<string>;
}

export interface ApprovalsApi {
  /** Shows the question in the window. Resolves once shown, not once answered. */
  request(approval: Approval): Promise<void>;
}

/** A reminder as stored by the Rust scheduler. */
export interface Reminder {
  id: string;
  message: string;
  /** Unix time in milliseconds. */
  dueAtMs: number;
}

/** Reminder operations implemented by the Rust backend (`reminders.rs`). */
export interface ReminderApi {
  add(message: string, dueAtMs: number): Promise<Reminder>;
  list(): Promise<Reminder[]>;
  cancel(id: string): Promise<boolean>;
}

/** App-level actions. Anything that closes the app asks the user first. */
export interface AppApi {
  /** Shows a confirmation in the JARVIS window. Resolves once it is shown, not once the user answers. */
  requestQuit(): Promise<void>;
}

/** Rule creation waits for the user's confirmation in the window. */
export interface RulesApi {
  requestCreate(rule: Rule): Promise<void>;
}

/** Widget visibility, changed by the user or by tools. */
export interface WidgetsApi {
  list(): { id: string; visible: boolean }[];
  setVisible(id: string, visible: boolean): Promise<void>;
}

/** Runtime information and services passed to every tool. */
export interface ToolContext {
  os: Os;
  capabilities: readonly Capability[];
  now: () => Date;
  fetch: typeof fetch;
  system: SystemApi;
  store: DocumentStore;
  reminders: ReminderApi;
  app: AppApi;
  widgets: WidgetsApi;
  rules: RulesApi;
  web: WebApi;
  files: FilesApi;
  secrets: { get(name: ReadableSecret): Promise<string | null> };
  accounts: AccountsApi;
  messaging: MessagingApi;
  approvals: ApprovalsApi;
  /** Names of the tools rules may run (the registry's tools, minus the excluded ones). */
  knownTools: readonly string[];
}

export interface ToolDefinition {
  /** snake_case name exposed to the model. Must be unique. */
  name: string;
  /** English description written for the model. */
  description: string;
  parameters: Extract<JsonSchema, { type: "object" }>;
  /** Operating systems where the tool works. */
  platforms: readonly Os[];
  /** Platform capabilities the tool depends on. All must be present. */
  requires?: readonly Capability[];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Function declaration shape sent to the model. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: ToolDefinition["parameters"];
}

export const ok = (output: string): ToolResult => ({ ok: true, output });

export const fail = (code: ToolErrorCode, error: string): ToolResult => ({
  ok: false,
  code,
  error,
});

/** Maps an exception thrown inside a tool to a failed result. */
export function failureFrom(error: unknown): ToolResult {
  if (error instanceof InvalidInput) return fail("invalid_arguments", error.message);
  return fail("failed", error instanceof Error ? error.message : String(error));
}
