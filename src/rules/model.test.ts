import { describe, expect, it } from "vitest";
import { InvalidInput } from "../data/records";
import {
  buildRule,
  describeTrigger,
  nextRunAt,
  normalizePhrase,
  PhraseMatcher,
  type Rule,
  type RuleInput,
} from "./model";

const KNOWN = ["open_app", "weather_report", "reminder", "shutdown_jarvis", "rules_engine"];
const NOW = new Date(2026, 0, 5, 9, 0); // Monday 5 Jan 2026, 09:00 local

function input(overrides: Partial<RuleInput>): RuleInput {
  return {
    name: "Morning",
    trigger_type: "daily",
    time: "08:30",
    tool_name: "weather_report",
    ...overrides,
  };
}

describe("normalizePhrase", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalizePhrase("¡Hola,  JARVIS!")).toBe("hola jarvis");
    expect(normalizePhrase("Buenos días")).toBe("buenos dias");
  });
});

describe("PhraseMatcher", () => {
  const rule = (overrides: Partial<Rule> = {}): Rule => ({
    id: "r1",
    name: "Music",
    enabled: true,
    trigger: { kind: "phrase", phrases: ["pon musica"] },
    toolName: "open_app",
    toolArgs: { app_name: "Spotify" },
    nextRunAtMs: null,
    createdAtMs: 0,
    ...overrides,
  });

  it("matches a phrase split across speech chunks", () => {
    const matcher = new PhraseMatcher();
    expect(matcher.feed("ey, pon", [rule()])).toEqual([]);
    expect(matcher.feed(" música por favor", [rule()]).map((r) => r.id)).toEqual(["r1"]);
  });

  it("fires once per turn and again after the turn ends", () => {
    const matcher = new PhraseMatcher();
    expect(matcher.feed("pon música", [rule()])).toHaveLength(1);
    expect(matcher.feed("pon música otra vez", [rule()])).toHaveLength(0);
    matcher.reset();
    expect(matcher.feed("pon música", [rule()])).toHaveLength(1);
  });

  it("does not match inside a longer word, and skips disabled rules", () => {
    const matcher = new PhraseMatcher();
    expect(matcher.feed("ponmusicaxx", [rule()])).toEqual([]);
    expect(matcher.feed("pon música", [rule({ enabled: false })])).toEqual([]);
  });
});

describe("nextRunAt", () => {
  it("gives today's time when it is still ahead", () => {
    expect(nextRunAt({ kind: "daily", time: "10:00" }, NOW)).toBe(
      new Date(2026, 0, 5, 10, 0).getTime(),
    );
  });

  it("moves to tomorrow once today's time has passed", () => {
    expect(nextRunAt({ kind: "daily", time: "08:30" }, NOW)).toBe(
      new Date(2026, 0, 6, 8, 30).getTime(),
    );
  });

  it("finds the next selected weekday", () => {
    // Wednesday (3) at 07:00 after Monday 09:00.
    expect(nextRunAt({ kind: "weekly", time: "07:00", weekdays: [3] }, NOW)).toBe(
      new Date(2026, 0, 7, 7, 0).getTime(),
    );
  });

  it("adds the interval to now", () => {
    expect(nextRunAt({ kind: "interval", everyMinutes: 30 }, NOW)).toBe(
      NOW.getTime() + 30 * 60_000,
    );
  });

  it("has no time for phrase rules", () => {
    expect(nextRunAt({ kind: "phrase", phrases: ["hola"] }, NOW)).toBeNull();
  });
});

describe("buildRule", () => {
  const options = { id: "r1", now: NOW, knownTools: KNOWN, existingCount: 0 };

  it("builds a daily rule with its next run", () => {
    const rule = buildRule(input({ tool_args_json: '{"city":"Lima"}' }), options);
    expect(rule).toMatchObject({
      name: "Morning",
      enabled: true,
      trigger: { kind: "daily", time: "08:30" },
      toolName: "weather_report",
      toolArgs: { city: "Lima" },
      nextRunAtMs: new Date(2026, 0, 6, 8, 30).getTime(),
    });
  });

  it("builds a phrase rule with normalized, unique phrases", () => {
    const rule = buildRule(
      input({
        trigger_type: "phrase",
        phrases: ["Pon música", "pon musica", "Música!"],
        time: undefined,
      }),
      options,
    );
    expect(rule.trigger).toEqual({ kind: "phrase", phrases: ["pon musica", "musica"] });
    expect(rule.nextRunAtMs).toBeNull();
  });

  it("refuses tools that rules must not run", () => {
    expect(() => buildRule(input({ tool_name: "shutdown_jarvis" }), options)).toThrow(
      /cannot be run by a rule/,
    );
    expect(() => buildRule(input({ tool_name: "rules_engine" }), options)).toThrow(
      /cannot be run by a rule/,
    );
  });

  it("refuses unknown tools and malformed input", () => {
    expect(() => buildRule(input({ tool_name: "launch_rockets" }), options)).toThrow(
      /no tool named/,
    );
    expect(() => buildRule(input({ time: "25:00" }), options)).toThrow(InvalidInput);
    expect(() => buildRule(input({ tool_args_json: "[1]" }), options)).toThrow(/JSON object/);
    expect(() => buildRule(input({ trigger_type: "phrase", phrases: ["a"] }), options)).toThrow(
      /between/,
    );
    expect(() => buildRule(input({ trigger_type: "interval", every_minutes: 0 }), options)).toThrow(
      /every_minutes/,
    );
    expect(() => buildRule(input({ trigger_type: "weekly", weekdays: [7] }), options)).toThrow(
      /weekdays/,
    );
  });

  it("refuses more rules than the limit", () => {
    expect(() => buildRule(input({}), { ...options, existingCount: 50 })).toThrow(
      /already 50 rules/,
    );
  });
});

describe("describeTrigger", () => {
  it("describes each trigger in plain words", () => {
    expect(describeTrigger({ kind: "phrase", phrases: ["buenos dias"] })).toBe(
      'when you say "buenos dias"',
    );
    expect(describeTrigger({ kind: "daily", time: "08:30" })).toBe("every day at 08:30");
    expect(describeTrigger({ kind: "weekly", time: "18:00", weekdays: [1, 5] })).toBe(
      "Mon, Fri at 18:00",
    );
    expect(describeTrigger({ kind: "interval", everyMinutes: 1 })).toBe("every 1 minute");
  });
});
