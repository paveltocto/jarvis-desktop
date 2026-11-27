import type { GoalsDocument } from "../../data/records";
import {
  addGoal,
  completeGoalStep,
  describeGoals,
  InvalidInput,
  removeGoal,
  setGoalProgress,
} from "../../data/records";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

/** Ported from legacy `goals` (actions/goals.py). */
export const goals: ToolDefinition = {
  name: "goals",
  description:
    "Tracks the user's goals with optional deadline and steps. Actions: 'list' shows goals; 'add' creates one (title, optional deadline and steps); 'progress' sets a percentage; 'complete_step' marks one step done; 'remove' deletes a goal. Use the goal_id returned by 'add' or 'list' for the other actions.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "progress", "complete_step", "remove"],
        description: "What to do.",
      },
      goal_id: { type: "string", description: "Goal id, required except for list and add." },
      title: { type: "string", description: "Goal title. Required for add." },
      deadline: { type: "string", description: "Optional deadline as YYYY-MM-DD." },
      steps: { type: "array", items: { type: "string" }, description: "Optional steps for add." },
      progress: { type: "integer", description: "Percentage from 0 to 100, for progress." },
      step_index: {
        type: "integer",
        description: "Zero-based index of the step, for complete_step.",
      },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      switch (args.action) {
        case "list": {
          const current = await ctx.store.read<GoalsDocument>("goals");
          const lines = describeGoals(current);
          return ok(lines.length > 0 ? lines.join("\n") : "There are no goals yet.");
        }
        case "add": {
          const id = newGoalId(ctx.now());
          await ctx.store.update<GoalsDocument>("goals", (current) =>
            addGoal(current, { title: args.title, deadline: args.deadline, steps: args.steps }, id),
          );
          return ok(`Added goal "${String(args.title).trim()}" (goal_id ${id}).`);
        }
        case "progress":
          await ctx.store.update<GoalsDocument>("goals", (current) =>
            setGoalProgress(current, args.goal_id, args.progress),
          );
          return ok(`Goal ${String(args.goal_id)} set to ${String(args.progress)}%.`);
        case "complete_step":
          await ctx.store.update<GoalsDocument>("goals", (current) =>
            completeGoalStep(current, args.goal_id, args.step_index),
          );
          return ok(`Step ${String(args.step_index)} of goal ${String(args.goal_id)} is done.`);
        case "remove":
          await ctx.store.update<GoalsDocument>("goals", (current) =>
            removeGoal(current, args.goal_id),
          );
          return ok(`Removed goal ${String(args.goal_id)}.`);
        default:
          return failureFrom(
            new InvalidInput(
              'action must be "list", "add", "progress", "complete_step" or "remove".',
            ),
          );
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};

function newGoalId(now: Date): string {
  return `g${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
