import { describe, expect, it, vi } from "vitest";
import type { Rule } from "./model";
import { runRuleAction } from "./runner";

const rule = (toolName: string): Rule => ({
  id: "r",
  name: "Test",
  enabled: true,
  trigger: { kind: "phrase", phrases: ["hola"] },
  toolName,
  toolArgs: { city: "Lima" },
  nextRunAtMs: null,
  createdAtMs: 0,
});

describe("runRuleAction", () => {
  it("runs the stored tool with the stored arguments", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, output: "done" });
    const result = await runRuleAction(rule("weather_report"), execute);
    expect(execute).toHaveBeenCalledWith("weather_report", { city: "Lima" });
    expect(result).toEqual({ ok: true, output: "done" });
  });

  it("refuses an excluded tool even when the stored rule names it", async () => {
    const execute = vi.fn();
    const result = await runRuleAction(rule("shutdown_jarvis"), execute);
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
  });
});
