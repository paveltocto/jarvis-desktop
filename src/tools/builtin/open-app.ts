import type { ToolDefinition } from "../types";
import { fail, ok } from "../types";

/** Ported from legacy `open_app` (actions/open_app.py). */
export const openApp: ToolDefinition = {
  name: "open_app",
  description:
    "Opens an application installed on this computer by name, for example 'Safari', 'Spotify' or 'Visual Studio Code'.",
  parameters: {
    type: "object",
    properties: {
      app_name: {
        type: "string",
        description: "Application name as it appears in the Applications folder.",
      },
    },
    required: ["app_name"],
  },
  platforms: ["macos", "windows"],
  requires: ["open_app"],
  async execute(args, ctx) {
    const name = typeof args.app_name === "string" ? args.app_name.trim() : "";
    if (!name) return fail("invalid_arguments", "app_name must be a non-empty string.");
    try {
      await ctx.system.openApp(name);
      return ok(`Opened ${name}.`);
    } catch (error) {
      return fail("failed", `Could not open ${name}: ${errorMessage(error)}`);
    }
  },
};

/** Tauri rejects commands with the serialized Rust error. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const { message, feature } = error as { message?: unknown; feature?: unknown };
    if (typeof message === "string") return message;
    if (typeof feature === "string") return `${feature} is not supported on this computer`;
  }
  return String(error);
}
