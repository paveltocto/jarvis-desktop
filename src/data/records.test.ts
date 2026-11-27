import { describe, expect, it } from "vitest";
import {
  addGoal,
  completeGoalStep,
  findProtocol,
  forgetEntry,
  formatMemoryForPrompt,
  formatProfileForPrompt,
  InvalidInput,
  MEMORY_MAX_TOTAL_CHARS,
  MEMORY_MAX_VALUE_CHARS,
  type MemoryDocument,
  rememberEntry,
  removeGoal,
  removeProfileValue,
  setGoalProgress,
  setProfileValue,
} from "./records";

describe("memory", () => {
  it("stores a value under category and key, replacing an earlier one", () => {
    let memory = rememberEntry(null, "preferences", "coffee", "espresso");
    memory = rememberEntry(memory, "preferences", "coffee", "flat white");
    expect(memory).toEqual({ preferences: { coffee: { value: "flat white" } } });
  });

  it("truncates long values instead of rejecting them", () => {
    const memory = rememberEntry(null, "notes", "long", "x".repeat(MEMORY_MAX_VALUE_CHARS + 50));
    expect(memory.notes?.long?.value).toHaveLength(
      MEMORY_MAX_VALUE_CHARS + "... [truncated]".length,
    );
    expect(memory.notes?.long?.value.endsWith("... [truncated]")).toBe(true);
  });

  it("drops the oldest entries when the total size is exceeded", () => {
    let memory: MemoryDocument | null = null;
    for (let index = 0; index < 20; index++) {
      memory = rememberEntry(memory, "notes", `item${index}`, "y".repeat(400));
    }
    const size = Object.values(memory ?? {})
      .flatMap((keys) => Object.values(keys))
      .reduce((total, entry) => total + entry.value.length + "notes".length + "item00".length, 0);
    expect(size).toBeLessThanOrEqual(MEMORY_MAX_TOTAL_CHARS);
    expect(memory?.notes?.item19).toBeDefined();
    expect(memory?.notes?.item0).toBeUndefined();
  });

  it("refuses empty categories, keys and values", () => {
    expect(() => rememberEntry(null, " ", "k", "v")).toThrow(InvalidInput);
    expect(() => rememberEntry(null, "c", "", "v")).toThrow(InvalidInput);
    expect(() => rememberEntry(null, "c", "k", undefined)).toThrow(InvalidInput);
  });

  it("forgets an entry and removes an empty category", () => {
    const memory = rememberEntry(null, "people", "sister", "Ana");
    expect(forgetEntry(memory, "people", "sister")).toEqual({});
    expect(() => forgetEntry(memory, "people", "brother")).toThrow(/No memory named/);
  });

  it("formats memory for the system instruction, grouped by category", () => {
    const memory = rememberEntry(
      rememberEntry(null, "people", "sister", "Ana"),
      "habits",
      "wake",
      "7am",
    );
    expect(formatMemoryForPrompt(memory)).toBe(
      [
        "LONG-TERM MEMORY (things the user asked you to remember):",
        "* HABITS:",
        "  - wake: 7am",
        "* PEOPLE:",
        "  - sister: Ana",
      ].join("\n"),
    );
    expect(formatMemoryForPrompt(null)).toBe("");
  });
});

describe("profile", () => {
  it("sets, overwrites and removes values", () => {
    let profile = setProfileValue(null, "timezone", "America/Lima");
    profile = setProfileValue(profile, "timezone", "Europe/Madrid");
    expect(profile).toEqual({ timezone: "Europe/Madrid" });
    expect(removeProfileValue(profile, "timezone")).toEqual({});
    expect(() => removeProfileValue(profile, "name")).toThrow(/No profile value/);
  });

  it("formats the profile for the system instruction", () => {
    expect(formatProfileForPrompt({ name: "Pavel" })).toBe("USER PROFILE:\n- name: Pavel");
    expect(formatProfileForPrompt({})).toBe("");
  });
});

describe("goals", () => {
  it("adds a goal with steps and computes progress from completed steps", () => {
    let goals = addGoal(
      null,
      { title: "Learn Rust", deadline: "2027-01-31", steps: ["Book", "Read"] },
      "g1",
    );
    expect(goals[0]).toMatchObject({ id: "g1", deadline: "2027-01-31", progress: 0 });
    goals = completeGoalStep(goals, "g1", 0);
    expect(goals[0]?.progress).toBe(50);
    expect(goals[0]?.steps[0]?.done).toBe(true);
  });

  it("rejects a malformed deadline and an out-of-range step", () => {
    expect(() => addGoal(null, { title: "x", deadline: "31/01/2027" }, "g1")).toThrow(/YYYY-MM-DD/);
    const goals = addGoal(null, { title: "x", steps: ["one"] }, "g1");
    expect(() => completeGoalStep(goals, "g1", 3)).toThrow(/between 0 and 0/);
    expect(() => completeGoalStep(goals, "missing", 0)).toThrow(/No goal with id/);
  });

  it("sets progress only within 0 to 100 and removes goals", () => {
    const goals = addGoal(null, { title: "x" }, "g1");
    expect(setGoalProgress(goals, "g1", 40)[0]?.progress).toBe(40);
    expect(() => setGoalProgress(goals, "g1", 101)).toThrow(InvalidInput);
    expect(removeGoal(goals, "g1")).toEqual([]);
  });
});

describe("protocols", () => {
  const protocols = { "morning routine": "Open the calendar and read the first meeting." };

  it("finds a protocol regardless of case", () => {
    expect(findProtocol(protocols, "Morning Routine").instructions).toMatch(/calendar/);
  });

  it("names the known protocols when one is missing", () => {
    expect(() => findProtocol(protocols, "focus")).toThrow(/Known protocols: morning routine/);
    expect(() => findProtocol(null, "focus")).toThrow(/No protocols are defined yet/);
  });
});
