import type { DocumentStore } from "../data/document-store";
import { LEGACY_STORAGE_KEY, parseSettings, type Settings } from "../config";

/** Minimal view of `localStorage`, so the migration can be tested. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * Loads settings from the `settings` document. On the first run after the
 * move from localStorage, the old values are copied into the document and
 * then removed from localStorage. The copy is removed only after the write
 * succeeds, so a failed write never loses the settings.
 */
export async function loadSettings(
  store: DocumentStore,
  legacy: KeyValueStorage,
): Promise<Settings> {
  const stored = await store.read<unknown>("settings");
  if (stored !== null) return parseSettings(stored);

  const raw = safeGet(legacy);
  if (raw === null) return parseSettings(null);

  let migrated: Settings;
  try {
    migrated = parseSettings(JSON.parse(raw));
  } catch {
    migrated = parseSettings(null);
  }
  await saveSettings(store, migrated);
  legacy.removeItem(LEGACY_STORAGE_KEY);
  return migrated;
}

export async function saveSettings(store: DocumentStore, settings: Settings): Promise<void> {
  await store.update<Settings>("settings", () => settings);
}

function safeGet(storage: KeyValueStorage): string | null {
  try {
    return storage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}
