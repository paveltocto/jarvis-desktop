import { Type } from "@google/genai";
import { describe, expect, it } from "vitest";
import { toFunctionDeclarations, toGeminiSchema } from "./schema";

describe("toGeminiSchema", () => {
  it("converts nested objects, arrays and enums", () => {
    expect(
      toGeminiSchema({
        type: "object",
        properties: {
          mode: { type: "string", enum: ["a", "b"], description: "Mode." },
          tags: { type: "array", items: { type: "string" } },
          count: { type: "integer" },
        },
        required: ["mode"],
      }),
    ).toEqual({
      type: Type.OBJECT,
      properties: {
        mode: { type: Type.STRING, enum: ["a", "b"], description: "Mode." },
        tags: { type: Type.ARRAY, items: { type: Type.STRING } },
        count: { type: Type.INTEGER },
      },
      required: ["mode"],
    });
  });
});

describe("toFunctionDeclarations", () => {
  it("omits parameters for tools without arguments", () => {
    const [declaration] = toFunctionDeclarations([
      { name: "ping", description: "Ping.", parameters: { type: "object", properties: {} } },
    ]);
    expect(declaration).toEqual({ name: "ping", description: "Ping." });
  });
});
