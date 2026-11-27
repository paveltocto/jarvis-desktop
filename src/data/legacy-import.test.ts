import { describe, expect, it } from "vitest";
import {
  importLegacyMemory,
  importLegacyProtocols,
  InvalidInput,
  type MemoryDocument,
  removeProtocol,
  rememberEntry,
  saveProtocol,
  protocolNames,
} from "./records";

describe("importLegacyMemory", () => {
  it("accepts the legacy layout with {value} entries and plain strings", () => {
    const result = importLegacyMemory(null, {
      notes: { wifi: { value: "home network" } },
      preferences: { coffee: "espresso" },
    });
    expect(result.document).toEqual({
      notes: { wifi: { value: "home network" } },
      preferences: { coffee: { value: "espresso" } },
    });
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("skips blank and non-text entries and reports them", () => {
    const result = importLegacyMemory(null, {
      notes: { empty: { value: "  " }, count: 3, ok: "yes" },
    });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("replaces an existing entry with the same category and key", () => {
    const current = rememberEntry(null, "notes", "wifi", "old");
    const result = importLegacyMemory(current, { notes: { wifi: "new" } });
    expect(result.document.notes?.wifi?.value).toBe("new");
    expect(result.dropped).toBe(0);
  });

  it("reports older entries dropped to fit the size limit", () => {
    // Values stay under the per-value cap, so the total is what grows.
    const value = "z".repeat(480);
    let current: MemoryDocument | null = null;
    for (let index = 0; index < 8; index++)
      current = rememberEntry(current, "notes", `old${index}`, value);
    const result = importLegacyMemory(current, { notes: { fresh: value } });
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.document.notes?.fresh).toBeDefined();
    expect(result.document.notes?.old0).toBeUndefined();
    expect(result.document.notes?.old7).toBeDefined();
  });

  it("refuses a file that is not an object", () => {
    expect(() => importLegacyMemory(null, ["a"])).toThrow(InvalidInput);
  });
});

describe("importLegacyProtocols", () => {
  it("imports new protocols in lowercase and keeps existing ones", () => {
    const current = { focus: "Mute notifications." };
    const result = importLegacyProtocols(current, {
      Focus: "Different text.",
      "Morning Routine": "Read the calendar.",
    });
    expect(result.document).toEqual({
      focus: "Mute notifications.",
      "morning routine": "Read the calendar.",
    });
    expect(result.imported).toEqual(["morning routine"]);
    expect(result.kept).toEqual(["focus"]);
  });

  it("skips entries that are not text", () => {
    const result = importLegacyProtocols(null, { review: 42, plan: "Plan the week." });
    expect(result.skipped).toBe(1);
    expect(result.imported).toEqual(["plan"]);
  });
});

describe("saving and removing protocols", () => {
  it("saves under a lowercase name, overwriting an existing one", () => {
    let document = saveProtocol(null, "Focus", "Mute notifications.");
    document = saveProtocol(document, "FOCUS", "Mute everything.");
    expect(document).toEqual({ focus: "Mute everything." });
    expect(protocolNames(document)).toEqual(["focus"]);
  });

  it("refuses empty instructions and removes an existing protocol", () => {
    expect(() => saveProtocol(null, "focus", "  ")).toThrow(InvalidInput);
    const document = saveProtocol(null, "focus", "Mute notifications.");
    expect(removeProtocol(document, "Focus")).toEqual({});
    expect(() => removeProtocol(document, "missing")).toThrow(/No protocol named/);
  });
});
