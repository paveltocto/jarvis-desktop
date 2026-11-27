import type { ProtocolsDocument } from "../../data/records";
import { saveProtocol } from "../../data/records";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

/** Creates or replaces a protocol. Protocols change how JARVIS behaves, so only save what the user asked for. */
export const saveProtocolTool: ToolDefinition = {
  name: "save_protocol",
  description:
    "Creates or replaces a named protocol: a set of instructions the user wants to reuse, activated later by name with activate_protocol. Save one only when the user explicitly asks for it, and only with instructions the user dictated or approved.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short name, for example 'focus' or 'morning routine'.",
      },
      instructions: {
        type: "string",
        description: "What JARVIS should do when the protocol is activated.",
      },
    },
    required: ["name", "instructions"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const name = String(args.name).trim().toLowerCase();
      await ctx.store.update<ProtocolsDocument>("protocols", (current) =>
        saveProtocol(current, args.name, args.instructions),
      );
      return ok(`Protocol "${name}" saved.`);
    } catch (error) {
      return failureFrom(error);
    }
  },
};
