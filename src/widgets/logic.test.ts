import { describe, expect, it } from "vitest";
import { featuredGoal, formatClock, formatDue, summarizeGoals } from "./logic";
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

describe("featuredGoal", () => {
  const goal = (title: string, progress: number) => ({ title, progress, deadline: null });

  it("skips finished goals", () => {
    expect(featuredGoal([goal("done", 100), goal("open", 20)])?.title).toBe("open");
  });

  it("falls back to the first goal, or none", () => {
    expect(featuredGoal([goal("done", 100)])?.title).toBe("done");
    expect(featuredGoal([])).toBeNull();
  });
});

describe("formatDue", () => {
  // 11:00 PM on March 15 in Lima.
  const now = new Date("2026-03-16T04:00:00Z");
  const due = (iso: string) => formatDue(Date.parse(iso), now, "America/Lima");

  it("names today and tomorrow in the time zone", () => {
    expect(due("2026-03-16T04:30:00Z")).toBe("Today 11:30 PM");
    expect(due("2026-03-16T05:30:00Z")).toBe("Tomorrow 12:30 AM");
    expect(due("2026-03-17T04:30:00Z")).toBe("Tomorrow 11:30 PM");
  });

  it("shows the date for anything else", () => {
    expect(due("2026-03-17T05:30:00Z")).toBe("Mar 17, 12:30 AM");
  });
});

describe("parseWidgetList", () => {
  it("drops unknown and duplicate ids and keeps catalog order", () => {
    expect(parseWidgetList(["goals", "clock", "nope", "goals"])).toEqual(["clock", "goals"]);
    expect(parseWidgetList("clock")).toEqual([]);
  });
});
