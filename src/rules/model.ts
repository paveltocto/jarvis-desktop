import { InvalidInput } from "../data/records";

/** Rule definitions are stored in the `rules` document. Shape is shared with the Rust scheduler. */
export type Trigger =
  | { kind: "phrase"; phrases: string[] }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] }
  | { kind: "interval"; everyMinutes: number };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  toolName: string;
  toolArgs: Record<string, unknown>;
  /** Next scheduled run, Unix ms. `null` for phrase rules. */
  nextRunAtMs: number | null;
  createdAtMs: number;
}

export type RulesDocument = Rule[];

/** Tools a rule may never run. `shutdown_jarvis` asks the user anyway; `rules_engine` must not edit itself. */
export const RULE_EXCLUDED_TOOLS: readonly string[] = ["shutdown_jarvis", "rules_engine"];

export const MAX_RULES = 50;
export const MAX_RULE_NAME_CHARS = 60;
const MAX_PHRASES = 5;
const MIN_PHRASE_CHARS = 3;
const MAX_PHRASE_CHARS = 60;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/* ---------------------------------------------------------- phrases */

/** Lowercase, no accents, no punctuation, single spaces. "¡Hola, Jarvis!" → "hola jarvis". */
export function normalizePhrase(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Finds phrase rules in what the user said. Speech arrives in pieces, so the
 * matcher keeps the words of the current turn. Each rule fires at most once
 * per turn, however often its phrase is repeated in the transcript.
 */
export class PhraseMatcher {
  #buffer = "";
  #fired = new Set<string>();

  /** Returns the enabled phrase rules that matched for the first time this turn. */
  feed(text: string, rules: readonly Rule[]): Rule[] {
    this.#buffer = `${this.#buffer} ${normalizePhrase(text)}`.trim().slice(-600);
    const matched: Rule[] = [];
    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.kind !== "phrase" || this.#fired.has(rule.id)) continue;
      const hit = rule.trigger.phrases.some((phrase) => containsWords(this.#buffer, phrase));
      if (hit) {
        this.#fired.add(rule.id);
        matched.push(rule);
      }
    }
    return matched;
  }

  /** Called when the user's turn ends. */
  reset(): void {
    this.#buffer = "";
    this.#fired.clear();
  }
}

/** Whole-word match on normalized text, so "jarvis" does not match "jarvisito". */
function containsWords(normalizedText: string, phrase: string): boolean {
  const needle = normalizePhrase(phrase);
  if (!needle) return false;
  return ` ${normalizedText} `.includes(` ${needle} `);
}

/* ---------------------------------------------------------- schedule */

function parseTime(value: string): { hours: number; minutes: number } {
  const match = TIME.exec(value);
  if (!match) throw new InvalidInput('time must be in 24-hour format, for example "08:30".');
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Next run strictly after `after`, in local time. `null` for phrase rules.
 * Daily and weekly rules look up to eight days ahead, which covers every weekday.
 */
export function nextRunAt(trigger: Trigger, after: Date): number | null {
  switch (trigger.kind) {
    case "phrase":
      return null;
    case "interval":
      return after.getTime() + trigger.everyMinutes * 60_000;
    case "daily":
      return nextClockTime(trigger.time, after, null);
    case "weekly":
      return nextClockTime(trigger.time, after, new Set(trigger.weekdays));
  }
}

function nextClockTime(time: string, after: Date, weekdays: Set<number> | null): number | null {
  const { hours, minutes } = parseTime(time);
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + dayOffset,
      hours,
      minutes,
      0,
      0,
    );
    if (candidate.getTime() <= after.getTime()) continue;
    if (weekdays && !weekdays.has(candidate.getDay())) continue;
    return candidate.getTime();
  }
  return null;
}

/* ----------------------------------------------------- user input */

export interface RuleInput {
  name: unknown;
  trigger_type: unknown;
  phrases?: unknown;
  time?: unknown;
  weekdays?: unknown;
  every_minutes?: unknown;
  tool_name: unknown;
  tool_args_json?: unknown;
}

/** Validates the model's or the user's input. `knownTools` is the set the registry offers. */
export function buildRule(
  input: RuleInput,
  options: { id: string; now: Date; knownTools: readonly string[]; existingCount: number },
): Rule {
  if (options.existingCount >= MAX_RULES) {
    throw new InvalidInput(`There are already ${MAX_RULES} rules. Delete some first.`);
  }
  const name = text(input.name, "name", MAX_RULE_NAME_CHARS);
  const toolName = text(input.tool_name, "tool_name", 60);
  if (RULE_EXCLUDED_TOOLS.includes(toolName)) {
    throw new InvalidInput(`The tool "${toolName}" cannot be run by a rule.`);
  }
  if (!options.knownTools.includes(toolName)) {
    throw new InvalidInput(`There is no tool named "${toolName}".`);
  }
  const toolArgs = parseToolArgs(input.tool_args_json);
  const trigger = buildTrigger(input);
  return {
    id: options.id,
    name,
    enabled: true,
    trigger,
    toolName,
    toolArgs,
    nextRunAtMs: nextRunAt(trigger, options.now),
    createdAtMs: options.now.getTime(),
  };
}

function buildTrigger(input: RuleInput): Trigger {
  switch (input.trigger_type) {
    case "phrase": {
      if (!Array.isArray(input.phrases))
        throw new InvalidInput("phrases must be a list of words or sentences.");
      const phrases = [
        ...new Set(input.phrases.map((phrase) => normalizePhrase(String(phrase)))),
      ].filter(Boolean);
      if (phrases.length === 0 || phrases.length > MAX_PHRASES) {
        throw new InvalidInput(`Give between 1 and ${MAX_PHRASES} phrases.`);
      }
      for (const phrase of phrases) {
        if (phrase.length < MIN_PHRASE_CHARS || phrase.length > MAX_PHRASE_CHARS) {
          throw new InvalidInput(
            `Each phrase must be between ${MIN_PHRASE_CHARS} and ${MAX_PHRASE_CHARS} characters.`,
          );
        }
      }
      return { kind: "phrase", phrases };
    }
    case "daily":
      parseTime(text(input.time, "time", 5));
      return { kind: "daily", time: text(input.time, "time", 5) };
    case "weekly": {
      parseTime(text(input.time, "time", 5));
      const weekdays = [...new Set(Array.isArray(input.weekdays) ? input.weekdays : [])];
      if (
        weekdays.length === 0 ||
        !weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      ) {
        throw new InvalidInput(
          "weekdays must be one or more numbers from 0 (Sunday) to 6 (Saturday).",
        );
      }
      return { kind: "weekly", time: text(input.time, "time", 5), weekdays: weekdays as number[] };
    }
    case "interval": {
      const minutes = input.every_minutes;
      if (
        typeof minutes !== "number" ||
        !Number.isInteger(minutes) ||
        minutes < 1 ||
        minutes > MAX_INTERVAL_MINUTES
      ) {
        throw new InvalidInput(
          `every_minutes must be a whole number from 1 to ${MAX_INTERVAL_MINUTES}.`,
        );
      }
      return { kind: "interval", everyMinutes: minutes };
    }
    default:
      throw new InvalidInput('trigger_type must be "phrase", "daily", "weekly" or "interval".');
  }
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string")
    throw new InvalidInput("tool_args_json must be a JSON object as text.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidInput("tool_args_json is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidInput("tool_args_json must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new InvalidInput(`${field} must be a non-empty string.`);
  if (result.length > max) throw new InvalidInput(`${field} must be at most ${max} characters.`);
  return result;
}

/** One-line description for the user, the confirmation and the Settings list. */
export function describeTrigger(trigger: Trigger): string {
  switch (trigger.kind) {
    case "phrase":
      return `when you say ${trigger.phrases.map((phrase) => `"${phrase}"`).join(" or ")}`;
    case "daily":
      return `every day at ${trigger.time}`;
    case "weekly": {
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return `${trigger.weekdays.map((day) => names[day]).join(", ")} at ${trigger.time}`;
    }
    case "interval":
      return `every ${trigger.everyMinutes} minute${trigger.everyMinutes === 1 ? "" : "s"}`;
  }
}
