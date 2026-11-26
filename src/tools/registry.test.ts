import { describe, expect, it } from "vitest";
import { ToolRegistry } from "./registry";
import type { ToolContext, ToolDefinition } from "./types";
import { ok } from "./types";

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  os: "macos",
  capabilities: [],
  now: () => new Date("2026-01-01T12:00:00Z"),
  fetch: () => Promise.reject(new Error("no network in tests")),
  system: { openApp: () => Promise.resolve() },
  ...overrides,
});

const tool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "sample_tool",
  description: "A sample tool.",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  platforms: ["macos"],
  execute: async (args) => ok(`got ${String(args.value)}`),
  ...overrides,
});

describe("ToolRegistry", () => {
  it("rejects names that are not snake_case", () => {
    expect(() => new ToolRegistry().register(tool({ name: "SampleTool" }))).toThrow(/snake_case/);
  });

  it("rejects duplicate names", () => {
    const registry = new ToolRegistry().register(tool());
    expect(() => registry.register(tool())).toThrow(/already registered/);
  });

  it("only declares tools for the current OS", () => {
    const registry = new ToolRegistry()
      .register(tool({ name: "mac_only", platforms: ["macos"] }))
      .register(tool({ name: "windows_only", platforms: ["windows"] }));
    expect(registry.declarations(ctx()).map((t) => t.name)).toEqual(["mac_only"]);
  });

  it("hides tools whose required capabilities are missing", () => {
    const registry = new ToolRegistry().register(tool({ requires: ["volume"] }));
    expect(registry.declarations(ctx())).toEqual([]);
    expect(registry.declarations(ctx({ capabilities: ["volume"] }))).toHaveLength(1);
  });

  it("declarations do not leak execute or platform metadata", () => {
    const [declaration] = new ToolRegistry().register(tool()).declarations(ctx());
    expect(Object.keys(declaration ?? {}).sort()).toEqual(["description", "name", "parameters"]);
  });

  it("reports unknown tools as failures", async () => {
    const result = await new ToolRegistry().execute("missing", {}, ctx());
    expect(result).toMatchObject({ ok: false, code: "unknown_tool" });
  });

  it("refuses to run a tool that is unavailable on this OS", async () => {
    const registry = new ToolRegistry().register(tool());
    const result = await registry.execute("sample_tool", { value: "x" }, ctx({ os: "windows" }));
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
  });

  it("validates required arguments", async () => {
    const result = await new ToolRegistry().register(tool()).execute("sample_tool", {}, ctx());
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("turns thrown errors into failures", async () => {
    const registry = new ToolRegistry().register(
      tool({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    );
    const result = await registry.execute("sample_tool", { value: "x" }, ctx());
    expect(result).toEqual({ ok: false, code: "failed", error: "boom" });
  });

  it("returns the tool result on success", async () => {
    const result = await new ToolRegistry()
      .register(tool())
      .execute("sample_tool", { value: "x" }, ctx());
    expect(result).toEqual({ ok: true, output: "got x" });
  });
});
