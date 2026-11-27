import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

/** Ported from legacy `shutdown_jarvis` (main.py). Legacy quit at once; here the user must confirm in the window. */
export const shutdownJarvis: ToolDefinition = {
  name: "shutdown_jarvis",
  description:
    "Closes JARVIS. The user is asked to confirm in the JARVIS window first, so the app does not close yet when this tool returns. Use it only when the user asks to shut down or quit JARVIS.",
  parameters: { type: "object", properties: {} },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(_args, ctx) {
    try {
      await ctx.app.requestQuit();
      return ok(
        "Asked the user to confirm in the JARVIS window. JARVIS has not closed yet; it closes only if the user confirms.",
      );
    } catch (error) {
      return failureFrom(error);
    }
  },
};
