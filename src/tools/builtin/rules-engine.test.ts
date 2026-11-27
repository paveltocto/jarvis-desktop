import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../../data/document-store";
import type { Rule, RulesDocument } from "../../rules/model";
import { memoryBackend, testContext } from "../testing/context";
import { rulesEngine } from "./rules-engine";

const NOW = new Date(2026, 0, 5, 9, 0);

function harness(initial: RulesDocument = []) {
  const backend = memoryBackend({ rules: initial });
  const asked: Rule[] = [];
  const ctx = testContext({
    now: () => NOW,
    store: createDocumentStore(backend),
    rules: {
      requestCreate: async (rule) => {
        asked.push(rule);
      },
    },
    knownTools: ["open_app", "weather_report"],
  });
  return { backend, asked, ctx };
}

describe("rules_engine", () => {
  it("asks for confirmation instead of creating the rule", async () => {
    const { backend, asked, ctx } = harness();
    const result = await rulesEngine.execute(
      {
        action: "create",
        name: "Music",
        trigger_type: "phrase",
        phrases: ["pon música"],
        tool_name: "open_app",
        tool_args_json: '{"app_name":"Spotify"}',
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      output: expect.stringContaining("not active until the user confirms"),
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      name: "Music",
      toolName: "open_app",
      toolArgs: { app_name: "Spotify" },
    });
    expect(backend.documents.rules).toEqual([]);
  });

  it("refuses to create a rule that runs an excluded tool", async () => {
    const { asked, ctx } = harness();
    const result = await rulesEngine.execute(
      {
        action: "create",
        name: "Bye",
        trigger_type: "daily",
        time: "08:00",
        tool_name: "shutdown_jarvis",
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(asked).toHaveLength(0);
  });

  it("lists, disables and deletes rules by id", async () => {
    const rule: Rule = {
      id: "ru1",
      name: "Morning",
      enabled: true,
      trigger: { kind: "daily", time: "08:30" },
      toolName: "weather_report",
      toolArgs: { city: "Lima" },
      nextRunAtMs: NOW.getTime(),
      createdAtMs: 0,
    };
    const { backend, ctx } = harness([rule]);
    expect(await rulesEngine.execute({ action: "list" }, ctx)).toEqual({
      ok: true,
      output: expect.stringContaining("[rule_id ru1] (on): every day at 08:30"),
    });
    expect(await rulesEngine.execute({ action: "disable", rule_id: "ru1" }, ctx)).toEqual({
      ok: true,
      output: "Rule ru1 disabled.",
    });
    expect((backend.documents.rules as RulesDocument)[0]?.enabled).toBe(false);
    expect(await rulesEngine.execute({ action: "delete", rule_id: "ru1" }, ctx)).toEqual({
      ok: true,
      output: "Rule ru1 deleted.",
    });
    expect(await rulesEngine.execute({ action: "delete", rule_id: "ru1" }, ctx)).toMatchObject({
      ok: false,
      code: "invalid_arguments",
    });
  });
});
