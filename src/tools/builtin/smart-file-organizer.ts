import { oneOf, optionalText } from "../args";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";
import { describeDisks } from "./system-monitor";

/** Ported from legacy `smart_file_organizer`. Duplicates are compared with SHA-256. */
export const smartFileOrganizer: ToolDefinition = {
  name: "smart_file_organizer",
  description:
    "Tidies a folder inside Desktop, Documents or Downloads. 'organize' moves its loose files into subfolders by type, after the user allows it in a dialog; 'find_duplicates' lists files with identical content and deletes nothing; 'disk_space' reports free disk space.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["organize", "find_duplicates", "disk_space"] },
      directory: {
        type: "string",
        description: "Folder such as 'desktop' or 'downloads/old'. Defaults to downloads.",
      },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const action = oneOf(args.action, ["organize", "find_duplicates", "disk_space"]);
      const path = optionalText(args, "directory") || "downloads";
      switch (action) {
        case "organize":
          return ok(await ctx.files.change({ action: "organize", path }));
        case "find_duplicates":
          return ok(await ctx.files.query({ action: "duplicates", path }));
        case "disk_space":
          return ok(describeDisks((await ctx.system.stats("cpu", 0)).disks).join("\n"));
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};
