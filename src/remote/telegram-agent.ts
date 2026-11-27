/**
 * Answers the messages the user sends from their own Telegram chat, using
 * OpenRouter or DeepSeek and a small set of tools. Replaces the legacy
 * `core/telegram_bot.py`, which could also type, take screenshots and send
 * files; none of that is available remotely.
 */
import { type ChatMessage, type ChatTool, complete, configuredProvider } from "../llm/chat";
import type { ToolContext, ToolDeclaration, ToolResult } from "../tools/types";

/**
 * The only tools a Telegram message can reach. Nothing here touches files,
 * email or the browser, or needs a confirmation at the computer.
 */
export const REMOTE_TOOLS: readonly string[] = [
  "get_current_time",
  "weather_report",
  "system_monitor",
  "reminder",
  "goals",
  "spotify_control",
];

const MAX_TOOL_ROUNDS = 4;
/** Earlier exchanges kept as context. */
const MAX_HISTORY = 12;
const MAX_INPUT_CHARS = 4_000;

export interface TelegramAgentOptions {
  context(): ToolContext;
  declarations(): ToolDeclaration[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  systemPrompt(): Promise<string>;
}

export class TelegramAgent {
  #history: ChatMessage[] = [];
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TelegramAgentOptions) {}

  /** Handles one message after the earlier ones and sends the reply. */
  receive(text: string): Promise<void> {
    const run = this.#queue.then(() => this.#answer(text.slice(0, MAX_INPUT_CHARS)));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #answer(text: string): Promise<void> {
    const ctx = this.options.context();
    let reply: string;
    try {
      reply = await this.#reply(ctx, text);
    } catch (error) {
      reply = `I could not answer: ${error instanceof Error ? error.message : String(error)}`;
    }
    await ctx.messaging.telegram(reply);
  }

  async #reply(ctx: ToolContext, text: string): Promise<string> {
    const configured = await configuredProvider(ctx.secrets, "deepseek").then(
      (found) => found ?? configuredProvider(ctx.secrets, "openrouter"),
    );
    if (!configured) {
      return "To chat here, add a DeepSeek or OpenRouter API key in JARVIS under Settings › Services.";
    }
    const tools: ChatTool[] = this.options
      .declarations()
      .filter((tool) => REMOTE_TOOLS.includes(tool.name))
      .map((tool) => ({ type: "function", function: tool }));
    const messages: ChatMessage[] = [
      { role: "system", content: await this.options.systemPrompt() },
      ...this.#history,
      { role: "user", content: text },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const answer = await complete(ctx.fetch, { ...configured, messages, tools });
      if (answer.toolCalls.length === 0) {
        this.#remember(text, answer.content);
        return answer.content;
      }
      messages.push({ role: "assistant", content: answer.content, tool_calls: answer.toolCalls });
      for (const call of answer.toolCalls) {
        const result = await this.#run(call.function.name, call.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.ok ? result.output : `Failed: ${result.error}`,
        });
      }
    }
    return "I could not finish that: it needed too many steps.";
  }

  async #run(name: string, rawArgs: string): Promise<ToolResult> {
    // Checked here too: the model may name a tool it was not offered.
    if (!REMOTE_TOOLS.includes(name)) {
      return { ok: false, code: "unsupported", error: `"${name}" cannot be used from Telegram.` };
    }
    let args: unknown;
    try {
      args = JSON.parse(rawArgs || "{}");
    } catch {
      return { ok: false, code: "invalid_arguments", error: "The arguments are not valid JSON." };
    }
    if (typeof args !== "object" || args === null) {
      return { ok: false, code: "invalid_arguments", error: "The arguments must be an object." };
    }
    return this.options.execute(name, args as Record<string, unknown>);
  }

  /** Only the exchange is kept, so tool calls and results never get cut apart. */
  #remember(question: string, answer: string): void {
    this.#history.push({ role: "user", content: question }, { role: "assistant", content: answer });
    this.#history = this.#history.slice(-MAX_HISTORY);
  }
}
