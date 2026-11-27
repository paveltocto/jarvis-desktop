import {
  createDocumentStore,
  type DocumentBackend,
  type DocumentName,
} from "../../data/document-store";
import type { Reminder, ToolContext } from "../types";

/** Document backend that keeps everything in memory. */
export function memoryBackend(
  initial: Partial<Record<DocumentName, unknown>> = {},
): DocumentBackend & {
  documents: Partial<Record<DocumentName, unknown>>;
} {
  const documents: Partial<Record<DocumentName, unknown>> = { ...initial };
  return {
    documents,
    read: async (name) => structuredClone(documents[name] ?? null),
    write: async (name, value) => {
      documents[name] = structuredClone(value);
    },
  };
}

/** Reminder service that keeps the list in memory. */
export function memoryReminders(): ToolContext["reminders"] & { items: Reminder[] } {
  const items: Reminder[] = [];
  let counter = 0;
  return {
    items,
    add: async (message, dueAtMs) => {
      const reminder = { id: `test-${++counter}`, message, dueAtMs };
      items.push(reminder);
      return reminder;
    },
    list: async () => [...items],
    cancel: async (id) => {
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return false;
      items.splice(index, 1);
      return true;
    },
  };
}

/**
 * A tool context for tests. Network, OS and storage calls fail unless
 * overridden: documents live in memory and reminders are kept in a list.
 */
export function testContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    os: "macos",
    capabilities: [],
    now: () => new Date("2026-01-01T12:00:00Z"),
    fetch: () => Promise.reject(new Error("no network in tests")),
    system: { openApp: () => Promise.reject(new Error("no OS in tests")) },
    store: createDocumentStore(memoryBackend()),
    reminders: memoryReminders(),
    app: { requestQuit: () => Promise.reject(new Error("no UI in tests")) },
    rules: { requestCreate: () => Promise.reject(new Error("no UI in tests")) },
    knownTools: ["open_app", "weather_report", "reminder"],
    widgets: {
      list: () => [],
      setVisible: () => Promise.reject(new Error("no UI in tests")),
    },
    ...overrides,
  };
}
