import { describe, expect, it } from "vitest";
import type { ToolContext } from "../types";
import { getCurrentTime } from "./get-current-time";

const ctx: ToolContext = {
  os: "macos",
  capabilities: [],
  now: () => new Date("2026-03-15T17:30:00Z"),
  fetch: () => Promise.reject(new Error("no network in tests")),
  system: { openApp: () => Promise.resolve() },
};

describe("get_current_time", () => {
  it("formats the time in the requested time zone", async () => {
    const result = await getCurrentTime.execute({ time_zone: "America/Lima" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.ok && result.output).toContain("12:30:00");
    expect(result.ok && result.output).toContain("March 15, 2026");
  });

  it("fails on an unknown time zone instead of guessing", async () => {
    const result = await getCurrentTime.execute({ time_zone: "Mars/Olympus" }, ctx);
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});
