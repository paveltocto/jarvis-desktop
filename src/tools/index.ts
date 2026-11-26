import { getCurrentTime } from "./builtin/get-current-time";
import { ToolRegistry } from "./registry";

/** Builds the registry with every tool that has been ported so far. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(getCurrentTime);
}
