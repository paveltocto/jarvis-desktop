import {
  createEvent,
  deleteEvent,
  describeEvent,
  describeWhen,
  eventTimes,
  getEvent,
  listEvents,
} from "../../google/calendar";
import { askUser } from "../approval";
import { boundedInteger, oneOf, optionalText, requiredText } from "../args";
import type { ToolDefinition } from "../types";
import { failureFrom, ok } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Implements legacy `google_calendar`, which only returned a fixed message. */
export const googleCalendar: ToolDefinition = {
  name: "google_calendar",
  description:
    "Reads and changes the user's main Google Calendar. Actions: 'list' (upcoming events for days_ahead days), 'create' (summary, start, optional end and location) and 'delete' (event_id from list). Create and delete ask the user to confirm first. Times are local, like 2026-03-05T14:30; a date alone means all day.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "create", "delete"] },
      days_ahead: { type: "integer", description: "For list, 1 to 60. Defaults to 7." },
      summary: { type: "string", description: "Event title." },
      start: { type: "string" },
      end: { type: "string", description: "For all-day events, the last day." },
      location: { type: "string" },
      event_id: { type: "string" },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    try {
      switch (oneOf(args.action, ["list", "create", "delete"])) {
        case "list": {
          const days = boundedInteger(args, "days_ahead", 7, 1, 60);
          const now = ctx.now();
          const events = await listEvents(ctx, now, new Date(now.getTime() + days * DAY_MS));
          return ok(
            events.length === 0
              ? `No events in the next ${days} days.`
              : events.map(describeEvent).join("\n"),
          );
        }
        case "create": {
          const summary = requiredText(args, "summary", 300);
          const location = optionalText(args, "location");
          const times = eventTimes(
            requiredText(args, "start", 40),
            optionalText(args, "end"),
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          );
          await ctx.accounts.accessToken("google");
          return await askUser(ctx, {
            title: `Add "${summary}" to your calendar?`,
            detail: `${describeWhen(times.start)}${location ? ` at ${location}` : ""}`,
            confirmLabel: "Add event",
            run: async () => {
              await createEvent(ctx, { summary, ...(location ? { location } : {}), ...times });
              return `Added "${summary}" to the calendar.`;
            },
          });
        }
        case "delete": {
          // Reading it first shows the user what they are deleting.
          const event = await getEvent(ctx, requiredText(args, "event_id", 1_024));
          const title = event.summary || "(no title)";
          return await askUser(ctx, {
            title: `Delete "${title}" from your calendar?`,
            detail: describeWhen(event.start),
            confirmLabel: "Delete event",
            run: async () => {
              await deleteEvent(ctx, event.id);
              return `Deleted "${title}" from the calendar.`;
            },
          });
        }
      }
    } catch (error) {
      return failureFrom(error);
    }
  },
};
