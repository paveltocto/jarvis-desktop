import type { ToolResult } from "../tools/types";
import { RULE_EXCLUDED_TOOLS, type Rule } from "./model";

/**
 * Runs a rule's action through the tool registry. Refuses excluded tools
 * again here, because the stored rule may come from an older or edited file.
 */
export async function runRuleAction(
  rule: Rule,
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (RULE_EXCLUDED_TOOLS.includes(rule.toolName)) {
    return { ok: false, code: "unsupported", error: `"${rule.toolName}" cannot be run by a rule.` };
  }
  return execute(rule.toolName, rule.toolArgs);
}

/** A scheduled run that is more than this late is skipped, not run late. */
export const RULE_GRACE_MS = 2 * 60 * 1000;
