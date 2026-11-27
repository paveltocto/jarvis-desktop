/**
 * Pure logic for the stored records: long-term memory, user profile, goals
 * and protocols. Nothing here touches storage or the OS; the tools combine
 * these functions with a `DocumentStore`.
 */

/** Thrown for input the user or the model got wrong. Tools report it as `invalid_arguments`. */
export class InvalidInput extends Error {
  override name = "InvalidInput";
}

const MAX_LABEL_CHARS = 100;

/** A copy of `record` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function clean(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new InvalidInput(`${field} must be a non-empty string.`);
  if (text.length > max) throw new InvalidInput(`${field} must be at most ${max} characters.`);
  return text;
}

/* ------------------------------------------------------------------ memory */

/** Legacy layout: `{ category: { key: { value } } }`, kept for the import. */
export type MemoryDocument = Record<string, Record<string, { value: string }>>;

export const MEMORY_MAX_VALUE_CHARS = 500;
/** Total size of the memory text sent to the model. Oldest entries go first. */
export const MEMORY_MAX_TOTAL_CHARS = 4000;

export function rememberEntry(
  document: MemoryDocument | null,
  category: unknown,
  key: unknown,
  value: unknown,
): MemoryDocument {
  const cat = clean(category, "category", MAX_LABEL_CHARS);
  const name = clean(key, "key", MAX_LABEL_CHARS);
  let text = clean(value, "value", Number.MAX_SAFE_INTEGER);
  if (text.length > MEMORY_MAX_VALUE_CHARS) {
    text = `${text.slice(0, MEMORY_MAX_VALUE_CHARS)}... [truncated]`;
  }

  const next: MemoryDocument = structuredClone(document ?? {});
  next[cat] ??= {};
  next[cat][name] = { value: text };
  return trimMemory(next);
}

export function forgetEntry(
  document: MemoryDocument | null,
  category: unknown,
  key: unknown,
): MemoryDocument {
  const cat = clean(category, "category", MAX_LABEL_CHARS);
  const name = clean(key, "key", MAX_LABEL_CHARS);
  const current = document ?? {};
  if (!current[cat]?.[name]) throw new InvalidInput(`No memory named "${cat} / ${name}".`);
  return removeMemoryEntry(current, cat, name);
}

/** Removes one entry, and its category when it becomes empty. */
function removeMemoryEntry(
  document: MemoryDocument,
  category: string,
  key: string,
): MemoryDocument {
  const keys = document[category];
  if (!keys || !(key in keys)) return document;
  const remaining = without(keys, key);
  return Object.keys(remaining).length === 0
    ? without(document, category)
    : { ...document, [category]: remaining };
}

function memoryEntries(
  document: MemoryDocument,
): Array<{ category: string; key: string; value: string }> {
  const entries: Array<{ category: string; key: string; value: string }> = [];
  for (const [category, keys] of Object.entries(document)) {
    for (const [key, entry] of Object.entries(keys)) {
      entries.push({ category, key, value: entry.value });
    }
  }
  return entries;
}

function memorySize(document: MemoryDocument): number {
  return memoryEntries(document).reduce(
    (total, { category, key, value }) => total + category.length + key.length + value.length,
    0,
  );
}

/** Drops the oldest entries (insertion order) until the memory fits the limit. */
function trimMemory(document: MemoryDocument): MemoryDocument {
  let current = document;
  let size = memorySize(current);
  while (size > MEMORY_MAX_TOTAL_CHARS) {
    const oldest = memoryEntries(current)[0];
    if (!oldest) break;
    current = removeMemoryEntry(current, oldest.category, oldest.key);
    size = memorySize(current);
  }
  return current;
}

/** Text for the system instruction. Empty when there is nothing stored. */
export function formatMemoryForPrompt(document: MemoryDocument | null): string {
  if (!document) return "";
  const entries = memoryEntries(document);
  if (entries.length === 0) return "";
  const lines = ["LONG-TERM MEMORY (things the user asked you to remember):"];
  let category: string | null = null;
  for (const entry of [...entries].sort((a, b) => a.category.localeCompare(b.category))) {
    if (entry.category !== category) {
      lines.push(`* ${entry.category.toUpperCase()}:`);
      category = entry.category;
    }
    lines.push(`  - ${entry.key}: ${entry.value}`);
  }
  return lines.join("\n");
}

/* ----------------------------------------------------------------- profile */

export type ProfileDocument = Record<string, string>;

export function setProfileValue(
  document: ProfileDocument | null,
  key: unknown,
  value: unknown,
): ProfileDocument {
  const name = clean(key, "key", MAX_LABEL_CHARS);
  const text = clean(value, "value", MEMORY_MAX_VALUE_CHARS);
  return { ...(document ?? {}), [name]: text };
}

export function removeProfileValue(
  document: ProfileDocument | null,
  key: unknown,
): ProfileDocument {
  const name = clean(key, "key", MAX_LABEL_CHARS);
  const current = document ?? {};
  if (!(name in current)) throw new InvalidInput(`No profile value named "${name}".`);
  return without(current, name);
}

export function formatProfileForPrompt(document: ProfileDocument | null): string {
  const entries = Object.entries(document ?? {});
  if (entries.length === 0) return "";
  return ["USER PROFILE:", ...entries.map(([key, value]) => `- ${key}: ${value}`)].join("\n");
}

/* ------------------------------------------------------------------- goals */

export interface GoalStep {
  text: string;
  done: boolean;
}

export interface Goal {
  id: string;
  title: string;
  /** ISO date (`YYYY-MM-DD`) or `null`. */
  deadline: string | null;
  /** 0..100. Computed from the steps when the goal has any. */
  progress: number;
  steps: GoalStep[];
}

export type GoalsDocument = Goal[];

export interface NewGoal {
  title: unknown;
  deadline?: unknown;
  steps?: unknown;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function progressFrom(steps: GoalStep[], fallback: number): number {
  if (steps.length === 0) return fallback;
  return Math.round((steps.filter((step) => step.done).length / steps.length) * 100);
}

function findGoal(goals: GoalsDocument, id: unknown): Goal {
  const goal = goals.find((item) => item.id === id);
  if (!goal) throw new InvalidInput(`No goal with id "${String(id)}".`);
  return goal;
}

export function addGoal(goals: GoalsDocument | null, input: NewGoal, id: string): GoalsDocument {
  const title = clean(input.title, "title", MAX_LABEL_CHARS);
  let deadline: string | null = null;
  if (input.deadline !== undefined && input.deadline !== null && input.deadline !== "") {
    if (typeof input.deadline !== "string" || !ISO_DATE.test(input.deadline)) {
      throw new InvalidInput("deadline must be a date in YYYY-MM-DD format.");
    }
    deadline = input.deadline;
  }
  const steps: GoalStep[] = [];
  if (Array.isArray(input.steps)) {
    for (const step of input.steps) {
      steps.push({ text: clean(step, "each step", MAX_LABEL_CHARS), done: false });
    }
  }
  const goal: Goal = { id, title, deadline, progress: 0, steps };
  return [...(goals ?? []), goal];
}

export function setGoalProgress(
  goals: GoalsDocument | null,
  id: unknown,
  progress: unknown,
): GoalsDocument {
  if (
    typeof progress !== "number" ||
    !Number.isInteger(progress) ||
    progress < 0 ||
    progress > 100
  ) {
    throw new InvalidInput("progress must be a whole number from 0 to 100.");
  }
  const current = goals ?? [];
  const target = findGoal(current, id);
  return current.map((goal) => (goal.id === target.id ? { ...goal, progress } : goal));
}

export function completeGoalStep(
  goals: GoalsDocument | null,
  id: unknown,
  stepIndex: unknown,
): GoalsDocument {
  const current = goals ?? [];
  const goal = findGoal(current, id);
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) {
    throw new InvalidInput("step_index must be a whole number.");
  }
  if (stepIndex < 0 || stepIndex >= goal.steps.length) {
    throw new InvalidInput(`step_index must be between 0 and ${goal.steps.length - 1}.`);
  }
  return current.map((item) => {
    if (item.id !== goal.id) return item;
    const steps = item.steps.map((step, index) =>
      index === stepIndex ? { ...step, done: true } : step,
    );
    return { ...item, steps, progress: progressFrom(steps, item.progress) };
  });
}

export function removeGoal(goals: GoalsDocument | null, id: unknown): GoalsDocument {
  const current = goals ?? [];
  const goal = findGoal(current, id);
  return current.filter((item) => item.id !== goal.id);
}

/** One line per goal, with its id so the model can refer to it. */
export function describeGoals(goals: GoalsDocument | null): string[] {
  return (goals ?? []).map((goal) => {
    const deadline = goal.deadline ? `, due ${goal.deadline}` : "";
    const steps =
      goal.steps.length > 0
        ? `, steps ${goal.steps.filter((s) => s.done).length}/${goal.steps.length}`
        : "";
    return `- ${goal.title} [goal_id ${goal.id}] (${goal.progress}%${deadline}${steps})`;
  });
}

export function formatGoalsForPrompt(goals: GoalsDocument | null): string {
  const lines = describeGoals(goals);
  if (lines.length === 0) return "";
  return ["USER GOALS:", ...lines].join("\n");
}

/* --------------------------------------------------------------- protocols */

/** Named instruction sets, keyed by lowercase name. Mirrors legacy `protocols.json`. */
export type ProtocolsDocument = Record<string, string>;

export function findProtocol(
  document: ProtocolsDocument | null,
  name: unknown,
): { name: string; instructions: string } {
  const requested = clean(name, "protocol_name", MAX_LABEL_CHARS).toLowerCase();
  const instructions = document?.[requested];
  if (instructions === undefined) {
    const known = Object.keys(document ?? {});
    throw new InvalidInput(
      known.length > 0
        ? `No protocol named "${requested}". Known protocols: ${known.join(", ")}.`
        : `No protocol named "${requested}". No protocols are defined yet.`,
    );
  }
  return { name: requested, instructions };
}

export function formatProtocolNamesForPrompt(document: ProtocolsDocument | null): string {
  const names = Object.keys(document ?? {});
  if (names.length === 0) return "";
  return `PROTOCOLS the user can ask you to activate: ${names.join(", ")}.`;
}

/* ------------------------------------------------- protocols: management */

export const MAX_PROTOCOL_CHARS = 2000;

export function saveProtocol(
  document: ProtocolsDocument | null,
  name: unknown,
  instructions: unknown,
): ProtocolsDocument {
  const key = clean(name, "name", MAX_LABEL_CHARS).toLowerCase();
  const text = clean(instructions, "instructions", MAX_PROTOCOL_CHARS);
  return { ...(document ?? {}), [key]: text };
}

export function removeProtocol(
  document: ProtocolsDocument | null,
  name: unknown,
): ProtocolsDocument {
  const key = clean(name, "name", MAX_LABEL_CHARS).toLowerCase();
  const current = document ?? {};
  if (!(key in current)) throw new InvalidInput(`No protocol named "${key}".`);
  return without(current, key);
}

export function protocolNames(document: ProtocolsDocument | null): string[] {
  return Object.keys(document ?? {}).sort();
}

/* ------------------------------------------------------- legacy import */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LegacyMemoryImport {
  document: MemoryDocument;
  imported: number;
  /** Entries in the file that were not a text value, or were blank. */
  skipped: number;
  /** Entries removed from the memory to stay within the size limit. */
  dropped: number;
}

/**
 * Merges the legacy `memory/long_term.json` into the current memory. Each
 * entry goes through `rememberEntry`, so the same limits apply. Entries in
 * the file replace entries with the same category and key.
 */
export function importLegacyMemory(
  current: MemoryDocument | null,
  legacy: unknown,
): LegacyMemoryImport {
  if (!isRecord(legacy)) throw new InvalidInput("The file does not contain a memory object.");
  let document: MemoryDocument = current ?? {};
  let imported = 0;
  let skipped = 0;
  for (const [category, keys] of Object.entries(legacy)) {
    if (!isRecord(keys)) {
      skipped++;
      continue;
    }
    for (const [key, entry] of Object.entries(keys)) {
      const value =
        typeof entry === "string"
          ? entry
          : isRecord(entry) && typeof entry.value === "string"
            ? entry.value
            : "";
      if (!value.trim()) {
        skipped++;
        continue;
      }
      try {
        document = rememberEntry(document, category, key, value);
        imported++;
      } catch {
        skipped++;
      }
    }
  }
  const overwritten = (category: string, key: string): boolean =>
    isRecord(legacy[category]) && key in legacy[category];
  const dropped = memoryEntries(current ?? {}).filter(
    ({ category, key }) => !overwritten(category, key) && !document[category]?.[key],
  ).length;
  return { document, imported, skipped, dropped };
}

export interface LegacyProtocolsImport {
  document: ProtocolsDocument;
  imported: string[];
  /** Names that already existed; the existing instructions were kept. */
  kept: string[];
  skipped: number;
}

export function importLegacyProtocols(
  current: ProtocolsDocument | null,
  legacy: unknown,
): LegacyProtocolsImport {
  if (!isRecord(legacy)) throw new InvalidInput("The file does not contain a protocols object.");
  const document: ProtocolsDocument = { ...(current ?? {}) };
  const imported: string[] = [];
  const kept: string[] = [];
  let skipped = 0;
  for (const [name, instructions] of Object.entries(legacy)) {
    const key = name.trim().toLowerCase();
    const text = typeof instructions === "string" ? instructions.trim() : "";
    if (!key || !text || key.length > MAX_LABEL_CHARS || text.length > MAX_PROTOCOL_CHARS) {
      skipped++;
    } else if (key in document) {
      kept.push(key);
    } else {
      document[key] = text;
      imported.push(key);
    }
  }
  return { document, imported, kept, skipped };
}
