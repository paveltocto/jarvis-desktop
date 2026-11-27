import { describe, expect, it } from "vitest";
import { clipWeather, formatClock, summarizeGoals, WEATHER_MAX_CHARS } from "./logic";
import { parseWidgetList } from "./catalog";

describe("formatClock", () => {
  it("uses the requested time zone", () => {
    const now = new Date("2026-03-15T17:30:00Z");
    expect(formatClock(now, "America/Lima").time).toBe("12:30 PM");
    expect(formatClock(now, "America/Lima").date).toContain("March 15");
  });
});

describe("summarizeGoals", () => {
  it("keeps only what the widget shows", () => {
    expect(
      summarizeGoals([{ id: "g1", title: "Run", deadline: null, progress: 40, steps: [] }]),
    ).toEqual([{ title: "Run", progress: 40, deadline: null }]);
    expect(summarizeGoals(null)).toEqual([]);
  });
});

describe("clipWeather", () => {
  it("collapses whitespace and cuts long text", () => {
    expect(clipWeather("Lima:\n  19 °C   cloudy")).toBe("Lima: 19 °C cloudy");
    expect(clipWeather("x".repeat(500))).toHaveLength(WEATHER_MAX_CHARS);
  });
});

describe("parseWidgetList", () => {
  it("drops unknown and duplicate ids and keeps catalog order", () => {
    expect(parseWidgetList(["goals", "clock", "nope", "goals"])).toEqual(["clock", "goals"]);
    expect(parseWidgetList("clock")).toEqual([]);
  });
});
