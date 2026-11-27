import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../data/document-store";
import { DEFAULT_SETTINGS, LEGACY_STORAGE_KEY } from "../config";
import { memoryBackend } from "../tools/testing/context";
import { type KeyValueStorage, loadSettings, saveSettings } from "./settings-store";

function fakeLocalStorage(
  initial: Record<string, string> = {},
): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    removeItem: (key) => {
      for (const name of Object.keys(data)) if (name === key) Reflect.deleteProperty(data, name);
    },
  };
}

describe("settings store", () => {
  it("returns defaults on a fresh install", async () => {
    const store = createDocumentStore(memoryBackend());
    expect(await loadSettings(store, fakeLocalStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates localStorage into the document and clears the old copy", async () => {
    const backend = memoryBackend();
    const legacy = fakeLocalStorage({
      [LEGACY_STORAGE_KEY]: JSON.stringify({ voice: "Kore", activationMode: "push_to_talk" }),
    });
    const loaded = await loadSettings(createDocumentStore(backend), legacy);
    expect(loaded).toMatchObject({ voice: "Kore", activationMode: "push_to_talk" });
    expect(backend.documents.settings).toMatchObject({ voice: "Kore" });
    expect(legacy.data[LEGACY_STORAGE_KEY]).toBeUndefined();
  });

  it("keeps the document when both sources exist", async () => {
    const backend = memoryBackend({ settings: { ...DEFAULT_SETTINGS, voice: "Puck" } });
    const legacy = fakeLocalStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify({ voice: "Kore" }) });
    expect((await loadSettings(createDocumentStore(backend), legacy)).voice).toBe("Puck");
    expect(legacy.data[LEGACY_STORAGE_KEY]).toBeDefined();
  });

  it("falls back to defaults for corrupt legacy data", async () => {
    const legacy = fakeLocalStorage({ [LEGACY_STORAGE_KEY]: "{not json" });
    const loaded = await loadSettings(createDocumentStore(memoryBackend()), legacy);
    expect(loaded).toEqual(DEFAULT_SETTINGS);
  });

  it("saves and reloads a change", async () => {
    const backend = memoryBackend();
    const store = createDocumentStore(backend);
    await saveSettings(store, { ...DEFAULT_SETTINGS, wakeWordThreshold: 0.3 });
    expect((await loadSettings(store, fakeLocalStorage())).wakeWordThreshold).toBe(0.3);
  });
});
