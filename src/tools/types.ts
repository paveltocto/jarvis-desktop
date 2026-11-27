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

/** OS operations implemented by the Rust platform layer. */
export interface SystemApi {
  openApp(name: string): Promise<void>;
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
