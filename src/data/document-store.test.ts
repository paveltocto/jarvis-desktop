import { describe, expect, it } from "vitest";
import { createDocumentStore } from "./document-store";
import { memoryBackend } from "../tools/testing/context";

describe("createDocumentStore", () => {
  it("runs concurrent updates to one document one after another", async () => {
    const backend = memoryBackend({ goals: [] });
    const store = createDocumentStore(backend);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update<string[]>("goals", (current) => [...(current ?? []), `goal ${index}`]),
      ),
    );
    expect(await store.read<string[]>("goals")).toHaveLength(10);
  });

  it("saves nothing when the change throws, and keeps later updates working", async () => {
    const backend = memoryBackend({ profile: { name: "Pavel" } });
    const store = createDocumentStore(backend);
    await expect(
      store.update("profile", () => {
        throw new Error("rejected");
      }),
    ).rejects.toThrow("rejected");
    expect(backend.documents.profile).toEqual({ name: "Pavel" });
    await store.update<Record<string, string>>("profile", (current) => ({
      ...current,
      city: "Lima",
    }));
    expect(backend.documents.profile).toEqual({ name: "Pavel", city: "Lima" });
  });

  it("returns null for a document that was never written", async () => {
    const store = createDocumentStore(memoryBackend());
    expect(await store.read("memory")).toBeNull();
  });
});
