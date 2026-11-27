import type { ProfileDocument } from "../../data/records";
import { InvalidInput, removeProfileValue, setProfileValue } from "../../data/records";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

/** Ported from legacy `user_profile` (actions/user_profile.py). The legacy version reported success without saving. */
export const userProfile: ToolDefinition = {
  name: "user_profile",
  description:
    "Reads or updates the user's profile: stable facts such as their name, timezone, language or work. 'get' returns everything stored; 'set' saves a key; 'remove' deletes a key.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["get", "set", "remove"], description: "What to do." },
      key: {
        type: "string",
        description:
          "Profile field, for example 'name' or 'timezone'. Required for set and remove.",
      },
      value: { type: "string", description: "Value to store. Required for set." },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      switch (args.action) {
        case "get": {
          const profile = await ctx.store.read<ProfileDocument>("profile");
          const entries = Object.entries(profile ?? {});
          if (entries.length === 0) return ok("The user profile is empty.");
          return ok(entries.map(([key, value]) => `${key}: ${value}`).join("\n"));
        }
        case "set":
          await ctx.store.update<ProfileDocument>("profile", (current) =>
            setProfileValue(current, args.key, args.value),
          );
          return ok(`Profile updated: ${String(args.key)}.`);
        case "remove":
          await ctx.store.update<ProfileDocument>("profile", (current) =>
            removeProfileValue(current, args.key),
          );
          return ok(`Removed from profile: ${String(args.key)}.`);
        default:
          return failureFrom(new InvalidInput('action must be "get", "set" or "remove".'));
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};
