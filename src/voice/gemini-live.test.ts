import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiSessionFactory } from "./gemini-live";

const connect = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = { connect };
  },
  Modality: { AUDIO: "AUDIO" },
}));

const handlers = {
  onAudio: vi.fn(),
  onInterrupted: vi.fn(),
  onTurnComplete: vi.fn(),
  onToolCalls: vi.fn(),
  onClose: vi.fn(),
};

async function sessionTools(declarations: { name: string }[]): Promise<unknown> {
  const factory = createGeminiSessionFactory({
    apiKey: "test-key",
    model: "test-model",
    voice: "test-voice",
    systemInstruction: () => "",
    tools: () => declarations,
  });
  await factory(handlers);
  return connect.mock.calls[0]?.[0].config.tools;
}

describe("createGeminiSessionFactory", () => {
  beforeEach(() => connect.mockClear());

  it("offers Google Search together with the app's tools", async () => {
    await expect(sessionTools([{ name: "get_current_time" }])).resolves.toEqual([
      { googleSearch: {} },
      { functionDeclarations: [{ name: "get_current_time" }] },
    ]);
  });

  it("offers Google Search without any app tools", async () => {
    await expect(sessionTools([])).resolves.toEqual([{ googleSearch: {} }]);
  });
});
