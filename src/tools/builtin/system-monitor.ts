import { boundedInteger, oneOf } from "../args";
import type { SystemStats, ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

export const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

export function describeDisks(disks: SystemStats["disks"]): string[] {
  return disks.map(
    (disk) =>
      `Disk ${disk.mountPoint}: ${gigabytes(disk.freeBytes)} free of ${gigabytes(disk.totalBytes)}`,
  );
}

/** Ported from legacy `system_monitor` (actions/system_monitor.py). Battery level is not reported. */
export const systemMonitor: ToolDefinition = {
  name: "system_monitor",
  description:
    "Reports this computer's CPU and memory use. Action 'status' also gives free disk space; 'processes' lists the programs using the most CPU or memory. Battery level is not available.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "processes"] },
      sort_by: { type: "string", enum: ["cpu", "memory"], description: "For processes." },
      count: { type: "integer", description: "How many processes, 1 to 15." },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const action = oneOf(args.action, ["status", "processes"]);
      const sort = args.sort_by ? oneOf(args.sort_by, ["cpu", "memory"], "sort_by") : "cpu";
      const count = action === "processes" ? boundedInteger(args, "count", 5, 1, 15) : 0;
      const stats = await ctx.system.stats(sort, count);
      const usage = `CPU: ${Math.round(stats.cpuPercent)}%. Memory: ${gigabytes(stats.memoryUsedBytes)} of ${gigabytes(stats.memoryTotalBytes)} used.`;
      if (action === "status") return ok([usage, ...describeDisks(stats.disks)].join("\n"));
      const lines = stats.processes.map(
        (process) =>
          `- ${process.name}: CPU ${Math.round(process.cpuPercent)}% of one core, memory ${gigabytes(process.memoryBytes)}`,
      );
      return ok([usage, `Top processes by ${sort}:`, ...lines].join("\n"));
    } catch (error) {
      return failureFrom(error);
    }
  },
};
