import { complete, configuredProvider, PROVIDER_IDS, PROVIDERS } from "../../llm/chat";
import { oneOf, optionalText, requiredText } from "../args";
import type { ToolDefinition } from "../types";
import { failureFrom, fail, ok } from "../types";

/** Ported from legacy `openrouter_agent` and `deepseek_agent`. Local Ollama is not ported. */
export const openrouterAgent: ToolDefinition = {
  name: "openrouter_agent",
  description:
    "Asks another AI model (through OpenRouter or DeepSeek) a hard question, for deeper reasoning or when the user asks for a second model. The question is sent to that service, so include only what is needed to answer it.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The complete question, with its context." },
      provider: {
        type: "string",
        enum: PROVIDER_IDS,
        description: "Service to use. Omit to use whichever is set up.",
      },
      model: {
        type: "string",
        description: "Model id, for example 'deepseek-reasoner'. Omit for the default.",
      },
    },
    required: ["query"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      const query = requiredText(args, "query", 20_000);
      const preferred = args.provider ? oneOf(args.provider, PROVIDER_IDS, "provider") : undefined;
      const configured = await configuredProvider(ctx.secrets, preferred);
      if (!configured) {
        return fail(
          "failed",
          "No API key for OpenRouter or DeepSeek is set up. The user can add one in Settings › Services.",
        );
      }
      const model = optionalText(args, "model");
      const { content } = await complete(ctx.fetch, {
        ...configured,
        ...(model ? { model } : {}),
        messages: [
          {
            role: "system",
            content: `You are a specialist consulted by the JARVIS assistant. Answer clearly and concisely, in the language of the question. The current local date and time is ${ctx.now().toString()}.`,
          },
          { role: "user", content: query },
        ],
      });
      return ok(`${PROVIDERS[configured.provider].label} answered:\n${content}`);
    } catch (error) {
      return failureFrom(error);
    }
  },
};
