import { InvalidInput } from "../../data/records";
import {
  buildRule,
  describeTrigger,
  type Rule,
  type RulesDocument,
  type RuleInput,
} from "../../rules/model";
import type { ToolDefinition } from "../types";
import { failureFrom, fail, ok } from "../types";

/** Ported from legacy `rules_engine` (actions/rules_engine.py), which matched phrases but never ran the action. */
export const rulesEngine: ToolDefinition = {
  name: "rules_engine",
  description:
    "Manages automation rules. A rule runs one tool automatically: when the user says a phrase, or at a time (daily, weekly on chosen days, or every N minutes). Actions: 'list'; 'create' (asks the user to confirm in the window; the rule is not active until they do); 'enable' and 'disable' and 'delete' take a rule_id. Only create a rule when the user asks for it.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "enable", "disable", "delete"],
        description: "What to do.",
      },
      rule_id: {
        type: "string",
        description: "Rule id from list, for enable, disable and delete.",
      },
      name: { type: "string", description: "Short name for the rule. Required for create." },
      trigger_type: {
        type: "string",
        enum: ["phrase", "daily", "weekly", "interval"],
        description: "What starts the rule. Required for create.",
      },
      phrases: {
        type: "array",
        items: { type: "string" },
        description:
          "Phrases that start the rule, for phrase triggers. The user must say one of them.",
      },
      time: {
        type: "string",
        description: "Local time as HH:MM, 24-hour clock, for daily and weekly.",
      },
      weekdays: {
        type: "array",
        items: { type: "integer" },
        description: "Days for weekly rules: 0 is Sunday through 6 is Saturday.",
      },
      every_minutes: { type: "integer", description: "Minutes between runs, for interval." },
      tool_name: {
        type: "string",
        description: "Tool the rule runs, for example 'open_app' or 'weather_report'.",
      },
      tool_args_json: {
        type: "string",
        description: 'Arguments for the tool as a JSON object, for example {"app_name":"Spotify"}.',
      },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      switch (args.action) {
        case "list": {
          const rules = await ctx.store.read<RulesDocument>("rules");
          if (!rules || rules.length === 0) return ok("There are no rules yet.");
          return ok(rules.map(describeRuleLine).join("\n"));
        }
        case "create": {
          const rule = buildRule(args as unknown as RuleInput, {
            id: newRuleId(ctx.now()),
            now: ctx.now(),
            knownTools: ctx.knownTools,
            existingCount: (await ctx.store.read<RulesDocument>("rules"))?.length ?? 0,
          });
          await ctx.rules.requestCreate(rule);
          return ok(
            `Asked the user to confirm the rule "${rule.name}" (${describeTrigger(rule.trigger)}) in the JARVIS window. It is not active until the user confirms.`,
          );
        }
        case "enable":
        case "disable": {
          const id = requireId(args.rule_id);
          const enabled = args.action === "enable";
          await ctx.store.update<RulesDocument>("rules", (current) =>
            setEnabled(current ?? [], id, enabled),
          );
          return ok(`Rule ${id} ${enabled ? "enabled" : "disabled"}.`);
        }
        case "delete": {
          const id = requireId(args.rule_id);
          await ctx.store.update<RulesDocument>("rules", (current) =>
            removeRule(current ?? [], id),
          );
          return ok(`Rule ${id} deleted.`);
        }
        default:
          return fail(
            "invalid_arguments",
            'action must be "list", "create", "enable", "disable" or "delete".',
          );
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};

function requireId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidInput("rule_id is required.");
  return value.trim();
}

function setEnabled(rules: RulesDocument, id: string, enabled: boolean): RulesDocument {
  if (!rules.some((rule) => rule.id === id)) throw new InvalidInput(`No rule with rule_id ${id}.`);
  return rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule));
}

function removeRule(rules: RulesDocument, id: string): RulesDocument {
  if (!rules.some((rule) => rule.id === id)) throw new InvalidInput(`No rule with rule_id ${id}.`);
  return rules.filter((rule) => rule.id !== id);
}

export function describeRuleLine(rule: Rule): string {
  const state = rule.enabled ? "on" : "off";
  return `- ${rule.name} [rule_id ${rule.id}] (${state}): ${describeTrigger(rule.trigger)} → ${rule.toolName}`;
}

function newRuleId(now: Date): string {
  return `ru${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
