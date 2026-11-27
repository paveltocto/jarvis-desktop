/** Reading the loosely typed arguments the model sends to tools. */
import { InvalidInput } from "../data/records";

/** The trimmed string argument, or `""` when it is missing or not a string. */
export function optionalText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export function requiredText(args: Record<string, unknown>, key: string, max = 100_000): string {
  const text = optionalText(args, key);
  if (!text) throw new InvalidInput(`${key} is required.`);
  if (text.length > max) throw new InvalidInput(`${key} must be at most ${max} characters.`);
  return text;
}

/** A whole number clamped to `min..max`; `fallback` when it is not a number. */
export function boundedInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(args[key] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name = "action"): T {
  if (allowed.includes(value as T)) return value as T;
  throw new InvalidInput(`${name} must be one of: ${allowed.join(", ")}.`);
}
