import { getCurrentTime } from "./builtin/get-current-time";
import { openApp } from "./builtin/open-app";
import { weatherReport } from "./builtin/weather-report";
import { ToolRegistry } from "./registry";

/** Builds the registry with every tool that has been ported so far. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(getCurrentTime).register(openApp).register(weatherReport);
}
