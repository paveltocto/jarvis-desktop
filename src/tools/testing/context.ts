import type { ToolContext } from "../types";

/** A tool context for tests. Network and OS calls fail unless overridden. */
export function testContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    os: "macos",
    capabilities: [],
    now: () => new Date("2026-01-01T12:00:00Z"),
    fetch: () => Promise.reject(new Error("no network in tests")),
    system: { openApp: () => Promise.reject(new Error("no OS in tests")) },
    ...overrides,
  };
}
