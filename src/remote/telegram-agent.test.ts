/* eslint-disable @typescript-eslint/no-non-null-assertion -- a missing value should fail the test */
import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../tools";
import { testContext } from "../tools/testing/context";
import type { ToolResult } from "../tools/types";
import { REMOTE_TOOLS, TelegramAgent } from "./telegram-agent";

const completion = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }));

const toolCall = (name: string) =>
  completion({
    content: null,
    tool_calls: [{ id: "1", type: "function", function: { name, arguments: "{}" } }],
  });

function setup(fetch: typeof globalThis.fetch, key: string | null = "k") {
  const telegram = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn(async (): Promise<ToolResult> => ({ ok: true, output: "noon" }));
  const ctx = testContext({ fetch, messaging: { telegram }, secrets: { get: async () => key } });
  const registry = createToolRegistry();
  const agent = new TelegramAgent({
    context: () => ctx,
    declarations: () => registry.declarations(ctx),
    execute,
    systemPrompt: async () => "system",
  });
  return { agent, telegram, execute };
}

describe("TelegramAgent", () => {
  it("only reaches tools that cannot touch files, mail or the browser", () => {
    for (const name of [
      "file_controller",
      "smart_file_organizer",
      "document_creator",
      "gmail_control",
      "google_calendar",
      "morning_brief",
      "browser_control",
      "unified_communications",
      "open_app",
      "rules_engine",
      "save_protocol",
      "shutdown_jarvis",
    ]) {
      expect(REMOTE_TOOLS).not.toContain(name);
    }
  });

  it("offers only those tools and sends the reply", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCall("get_current_time"))
      .mockResolvedValueOnce(completion({ content: "It is noon." }));
    const { agent, telegram, execute } = setup(fetch);
    await agent.receive("time?");
    const offered = JSON.parse(fetch.mock.calls[0]![1].body).tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    expect(offered.every((name: string) => REMOTE_TOOLS.includes(name))).toBe(true);
    expect(execute).toHaveBeenCalledWith("get_current_time", {});
    expect(telegram).toHaveBeenCalledWith("It is noon.");
  });

  it("refuses a tool the model was not offered", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(toolCall("file_controller"))
      .mockResolvedValueOnce(completion({ content: "no" }));
    const { agent, execute } = setup(fetch);
    await agent.receive("delete everything");
    expect(execute).not.toHaveBeenCalled();
  });

  it("replies with the reason when it cannot answer", async () => {
    const withoutKey = setup(vi.fn(), null);
    await withoutKey.agent.receive("hi");
    expect(withoutKey.telegram.mock.calls[0]?.[0]).toContain("API key");

    const offline = setup(vi.fn().mockRejectedValue(new Error("offline")));
    await offline.agent.receive("hi");
    expect(offline.telegram.mock.calls[0]?.[0]).toContain("offline");
  });
});
