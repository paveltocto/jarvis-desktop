import type { ToolDefinition } from "../types";
import { fail, ok } from "../types";

/** Ported from legacy `get_current_time` (main.py). Pure TypeScript, works everywhere. */
export const getCurrentTime: ToolDefinition = {
  name: "get_current_time",
  description:
    "Returns the current local date and time. Optionally pass an IANA time zone such as 'America/Lima'.",
  parameters: {
    type: "object",
    properties: {
      time_zone: {
        type: "string",
        description: "IANA time zone name. Defaults to the system time zone.",
      },
    },
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    const timeZone =
      typeof args.time_zone === "string" && args.time_zone ? args.time_zone : undefined;
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        ...(timeZone ? { timeZone } : {}),
      }).format(ctx.now());
      return ok(formatted);
    } catch {
      return fail("invalid_arguments", `Unknown time zone: "${timeZone}".`);
    }
  },
};
