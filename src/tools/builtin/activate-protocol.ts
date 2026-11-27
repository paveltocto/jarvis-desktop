import type { ProtocolsDocument } from "../../data/records";
import { findProtocol } from "../../data/records";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

/** Ported from legacy `activate_protocol` (core/protocols.py). */
export const activateProtocol: ToolDefinition = {
  name: "activate_protocol",
  description:
    "Activates a named protocol: a saved set of instructions the user defined. Use it when the user asks for a protocol by name. The result contains the instructions to follow.",
  parameters: {
    type: "object",
    properties: {
      protocol_name: { type: "string", description: "Name of the protocol, case-insensitive." },
    },
    required: ["protocol_name"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const document = await ctx.store.read<ProtocolsDocument>("protocols");
      const { name, instructions } = findProtocol(document, args.protocol_name);
      return ok(`Protocol "${name}" activated. Follow these instructions:\n${instructions}`);
    } catch (error) {
      return failureFrom(error);
    }
  },
};
