/** Chat completions from OpenRouter and DeepSeek, which share the OpenAI wire format. */
import { requestJson } from "../net/json-api";
import type { ToolContext } from "../tools/types";

export const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    secret: "openrouter_api_key",
    model: "google/gemini-2.5-flash",
  },
  deepseek: {
    label: "DeepSeek",
    url: "https://api.deepseek.com/chat/completions",
    secret: "deepseek_api_key",
    model: "deepseek-chat",
  },
} as const;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatOptions {
  provider: ProviderId;
  apiKey: string;
  messages: ChatMessage[];
  model?: string;
  tools?: ChatTool[];
}

const TIMEOUT_MS = 90_000;
const MAX_TOKENS = 1_500;

interface Completion {
  choices?: { message?: { content?: string | null; tool_calls?: ChatToolCall[] } }[];
}

/** One answer from the model. */
export async function complete(
  fetcher: typeof fetch,
  options: ChatOptions,
): Promise<{ content: string; toolCalls: ChatToolCall[] }> {
  const provider = PROVIDERS[options.provider];
  const body = await requestJson<Completion>(fetcher, provider.url, {
    service: provider.label,
    method: "POST",
    token: options.apiKey,
    timeoutMs: TIMEOUT_MS,
    body: {
      model: options.model || provider.model,
      max_tokens: MAX_TOKENS,
      messages: options.messages,
      ...(options.tools?.length ? { tools: options.tools } : {}),
    },
  });
  const message = body?.choices?.[0]?.message;
  const content = message?.content?.trim() ?? "";
  const toolCalls = message?.tool_calls ?? [];
  if (!content && toolCalls.length === 0) {
    throw new Error(`${provider.label} sent an empty answer.`);
  }
  return { content, toolCalls };
}

/** The provider's key, from the preferred provider or any that has one. */
export async function configuredProvider(
  secrets: ToolContext["secrets"],
  preferred?: ProviderId,
): Promise<{ provider: ProviderId; apiKey: string } | null> {
  for (const provider of preferred ? [preferred] : PROVIDER_IDS) {
    const apiKey = await secrets.get(PROVIDERS[provider].secret);
    if (apiKey) return { provider, apiKey };
  }
  return null;
}
