import type { MemoryDocument } from "../../data/records";
import { rememberEntry } from "../../data/records";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

/** Ported from legacy `save_memory` (memory/memory_manager.py). */
export const saveMemory: ToolDefinition = {
  name: "save_memory",
  description:
    "Saves a fact about the user or their preferences to long-term memory, so it is remembered in future conversations. Use it when the user asks you to remember something or states a lasting preference. Saving the same category and key replaces the old value.",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          "Group for the fact, for example 'preferences', 'people', 'notes' or 'habits'.",
      },
      key: {
        type: "string",
        description: "Short name for the fact, for example 'coffee' or 'sister_name'.",
      },
      value: { type: "string", description: "The fact itself, in one short sentence." },
    },
    required: ["category", "key", "value"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const category = String(args.category);
      const key = String(args.key);
      await ctx.store.update<MemoryDocument>("memory", (current) =>
        rememberEntry(current, args.category, args.key, args.value),
      );
      return ok(`Saved to memory: ${category} / ${key}.`);
    } catch (error) {
      return failureFrom(error);
    }
  },
};
