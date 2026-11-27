import type { ProtocolsDocument } from "../../data/records";
import { removeProtocol } from "../../data/records";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

export const removeProtocolTool: ToolDefinition = {
  name: "remove_protocol",
  description: "Deletes a saved protocol by name. Use it only when the user asks to delete it.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Name of the protocol to delete." } },
    required: ["name"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const name = String(args.name).trim().toLowerCase();
      await ctx.store.update<ProtocolsDocument>("protocols", (current) =>
        removeProtocol(current, args.name),
      );
      return ok(`Protocol "${name}" deleted.`);
    } catch (error) {
      return failureFrom(error);
    }
  },
};
