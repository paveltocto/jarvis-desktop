import type { ToolContext, ToolDeclaration, ToolDefinition, ToolResult } from "./types";
import { fail } from "./types";

/**
 * Holds every tool and decides which ones the model may see.
 *
 * A tool is offered only when the current OS is in its `platforms` list and
 * every capability in `requires` is reported by the Rust platform layer.
 * This replaces the legacy behaviour of declaring tools whose module was
 * missing or stubbed.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`Tool name must be snake_case: "${tool.name}"`);
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool already registered: "${tool.name}"`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  isAvailable(tool: ToolDefinition, ctx: Pick<ToolContext, "os" | "capabilities">): boolean {
    return (
      tool.platforms.includes(ctx.os) &&
      (tool.requires ?? []).every((capability) => ctx.capabilities.includes(capability))
    );
  }

  available(ctx: Pick<ToolContext, "os" | "capabilities">): ToolDefinition[] {
    return [...this.#tools.values()].filter((tool) => this.isAvailable(tool, ctx));
  }

  declarations(ctx: Pick<ToolContext, "os" | "capabilities">): ToolDeclaration[] {
    return this.available(ctx).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return fail("unknown_tool", `No tool named "${name}".`);
    }
    if (!this.isAvailable(tool, ctx)) {
      return fail("unsupported", `"${name}" is not available on ${ctx.os}.`);
    }
    const missing = (tool.parameters.required ?? []).filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return fail("invalid_arguments", `Missing required argument(s): ${missing.join(", ")}.`);
    }
    try {
      return await tool.execute(args, ctx);
    } catch (error) {
      return fail("failed", error instanceof Error ? error.message : String(error));
    }
  }
}
