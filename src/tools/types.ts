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

/** Runtime information passed to every tool. */
export interface ToolContext {
  os: Os;
  capabilities: readonly Capability[];
  now: () => Date;
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
