import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../../data/document-store";
import { memoryBackend, memoryReminders, testContext } from "../testing/context";
import { activateProtocol } from "./activate-protocol";
import { goals } from "./goals";
import { reminder } from "./reminder";
import { removeProtocolTool } from "./remove-protocol";
import { saveProtocolTool } from "./save-protocol";
import { saveMemory } from "./save-memory";
import { userProfile } from "./user-profile";

describe("save_memory", () => {
  it("stores the fact and reports what was saved", async () => {
    const backend = memoryBackend();
    const ctx = testContext({ store: createDocumentStore(backend) });
    const result = await saveMemory.execute(
      { category: "people", key: "sister", value: "Ana" },
      ctx,
    );
    expect(result).toEqual({ ok: true, output: "Saved to memory: people / sister." });
    expect(backend.documents.memory).toEqual({ people: { sister: { value: "Ana" } } });
  });

  it("reports invalid arguments instead of saving", async () => {
    const result = await saveMemory.execute({ category: "", key: "k", value: "v" }, testContext());
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});

describe("activate_protocol", () => {
  it("returns the instructions of the named protocol", async () => {
    const ctx = testContext({
      store: createDocumentStore(memoryBackend({ protocols: { focus: "Mute notifications." } })),
    });
    const result = await activateProtocol.execute({ protocol_name: "FOCUS" }, ctx);
    expect(result).toEqual({ ok: true, output: expect.stringContaining("Mute notifications.") });
  });

  it("fails when the protocol does not exist", async () => {
    const result = await activateProtocol.execute({ protocol_name: "focus" }, testContext());
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});

describe("user_profile", () => {
  it("saves a value and returns it on get", async () => {
    const backend = memoryBackend();
    const ctx = testContext({ store: createDocumentStore(backend) });
    expect(await userProfile.execute({ action: "get" }, ctx)).toEqual({
      ok: true,
      output: "The user profile is empty.",
    });
    await userProfile.execute({ action: "set", key: "timezone", value: "America/Lima" }, ctx);
    expect(backend.documents.profile).toEqual({ timezone: "America/Lima" });
    expect(await userProfile.execute({ action: "get" }, ctx)).toEqual({
      ok: true,
      output: "timezone: America/Lima",
    });
  });

  it("rejects an unknown action", async () => {
    const result = await userProfile.execute({ action: "delete_all" }, testContext());
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});

describe("goals", () => {
  it("adds a goal and returns its id so it can be updated", async () => {
    const backend = memoryBackend();
    const ctx = testContext({ store: createDocumentStore(backend) });
    const added = await goals.execute(
      { action: "add", title: "Run 5 km", steps: ["Plan route"] },
      ctx,
    );
    expect(added.ok).toBe(true);
    const id = /goal_id (\S+)\)/.exec(added.ok ? added.output : "")?.[1];
    expect(id).toBeTruthy();

    await goals.execute({ action: "complete_step", goal_id: id, step_index: 0 }, ctx);
    const listed = await goals.execute({ action: "list" }, ctx);
    expect(listed).toEqual({ ok: true, output: expect.stringContaining("(100%") });
  });

  it("fails for an unknown goal instead of reporting success", async () => {
    const result = await goals.execute(
      { action: "progress", goal_id: "nope", progress: 10 },
      testContext(),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});

describe("reminder", () => {
  const now = () => new Date(2026, 0, 1, 12, 0); // local time

  it("sets a reminder for a future local time", async () => {
    const reminders = memoryReminders();
    const result = await reminder.execute(
      { action: "set", message: "Call the dentist", due_at: "2026-01-01T15:30" },
      testContext({ now, reminders }),
    );
    expect(result).toEqual({ ok: true, output: expect.stringContaining("Call the dentist") });
    expect(reminders.items).toHaveLength(1);
    expect(new Date(reminders.items[0]?.dueAtMs ?? 0).getHours()).toBe(15);
  });

  it("refuses a time in the past or in an unreadable format", async () => {
    const reminders = memoryReminders();
    const ctx = testContext({ now, reminders });
    expect(
      await reminder.execute({ action: "set", message: "x", due_at: "2025-12-31T10:00" }, ctx),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(
      await reminder.execute({ action: "set", message: "x", due_at: "tomorrow at 3" }, ctx),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(reminders.items).toHaveLength(0);
  });

  it("lists and cancels reminders", async () => {
    const reminders = memoryReminders();
    const ctx = testContext({ now, reminders });
    const set = await reminder.execute(
      { action: "set", message: "Stretch", due_at: "2026-01-01T13:00" },
      ctx,
    );
    const id = /reminder_id (\S+)\)/.exec(set.ok ? set.output : "")?.[1] ?? "";
    expect(await reminder.execute({ action: "cancel", reminder_id: id }, ctx)).toMatchObject({
      ok: true,
    });
    expect(await reminder.execute({ action: "cancel", reminder_id: id }, ctx)).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    });
    expect(await reminder.execute({ action: "list" }, ctx)).toEqual({
      ok: true,
      output: "There are no pending reminders.",
    });
  });
});

describe("save_protocol and remove_protocol", () => {
  it("saves a protocol that activate_protocol can then return", async () => {
    const backend = memoryBackend();
    const ctx = testContext({ store: createDocumentStore(backend) });
    expect(
      await saveProtocolTool.execute({ name: "Focus", instructions: "Mute notifications." }, ctx),
    ).toEqual({ ok: true, output: 'Protocol "focus" saved.' });
    expect(await activateProtocol.execute({ protocol_name: "focus" }, ctx)).toEqual({
      ok: true,
      output: expect.stringContaining("Mute notifications."),
    });
  });

  it("deletes a protocol and reports a missing one as invalid", async () => {
    const ctx = testContext({
      store: createDocumentStore(memoryBackend({ protocols: { focus: "x" } })),
    });
    expect(await removeProtocolTool.execute({ name: "focus" }, ctx)).toEqual({
      ok: true,
      output: 'Protocol "focus" deleted.',
    });
    expect(await removeProtocolTool.execute({ name: "focus" }, ctx)).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    });
  });
});
