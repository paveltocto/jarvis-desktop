import type { ToolDefinition } from "../types";
import { fail, failureFrom, ok } from "../types";

/** Largest gap between now and a reminder. Longer ones are almost certainly a mistake. */
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** Ported from legacy `reminder` (actions/reminder.py). Legacy timers were lost on restart; these are stored and fired by the Rust scheduler. */
export const reminder: ToolDefinition = {
  name: "reminder",
  description:
    "Sets, lists or cancels reminders. 'set' needs the message and the local date and time to fire at, as YYYY-MM-DDTHH:MM (24-hour clock, the user's local time). Compute it from the current date and time in your instructions. 'cancel' needs the reminder_id from 'list'.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "list", "cancel"], description: "What to do." },
      message: { type: "string", description: "What to remind the user of. Required for set." },
      due_at: {
        type: "string",
        description: "Local date and time, for example 2026-11-26T15:30. Required for set.",
      },
      reminder_id: { type: "string", description: "Id of the reminder to cancel." },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      switch (args.action) {
        case "set": {
          const message = typeof args.message === "string" ? args.message.trim() : "";
          if (!message) return fail("invalid_arguments", "message must be a non-empty string.");
          const dueAt = typeof args.due_at === "string" ? args.due_at.trim() : "";
          if (!LOCAL_DATE_TIME.test(dueAt)) {
            return fail("invalid_arguments", "due_at must look like 2026-11-26T15:30.");
          }
          const dueAtMs = new Date(dueAt).getTime();
          if (Number.isNaN(dueAtMs))
            return fail("invalid_arguments", "due_at is not a valid date and time.");
          const now = ctx.now().getTime();
          if (dueAtMs <= now) return fail("invalid_arguments", "due_at is in the past.");
          if (dueAtMs - now > MAX_AHEAD_MS) {
            return fail("invalid_arguments", "Reminders can be set up to one year ahead.");
          }
          const saved = await ctx.reminders.add(message, dueAtMs);
          return ok(
            `Reminder set for ${formatLocal(saved.dueAtMs)}: ${saved.message} (reminder_id ${saved.id}).`,
          );
        }
        case "list": {
          const pending = await ctx.reminders.list();
          if (pending.length === 0) return ok("There are no pending reminders.");
          return ok(
            pending
              .map(
                (item) =>
                  `- ${formatLocal(item.dueAtMs)}: ${item.message} (reminder_id ${item.id})`,
              )
              .join("\n"),
          );
        }
        case "cancel": {
          const id = typeof args.reminder_id === "string" ? args.reminder_id.trim() : "";
          if (!id)
            return fail("invalid_arguments", "reminder_id is required to cancel a reminder.");
          const removed = await ctx.reminders.cancel(id);
          return removed
            ? ok(`Cancelled reminder ${id}.`)
            : fail("invalid_arguments", `No pending reminder with reminder_id ${id}.`);
        }
        default:
          return fail("invalid_arguments", 'action must be "set", "list" or "cancel".');
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};

function formatLocal(dueAtMs: number): string {
  return new Date(dueAtMs).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
