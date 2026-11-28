/** Events from one or more accounts, merged by start time, as text for the model. */
import type { GoogleAccount, ToolContext } from "../tools/types";
import { clientFor, describeFailures, fromEachAccount, successes } from "./accounts";
import { type CalendarEvent, describeEvent, listEvents } from "./calendar";

export const MAX_EVENTS_SHOWN = 40;

/** All-day events sort at the start of their day, in local time. */
function startsAt(event: CalendarEvent): number {
  return Date.parse(event.start?.dateTime ?? `${event.start?.date ?? ""}T00:00:00`) || 0;
}

/** Throws when no account's calendar could be read. */
export async function calendarReport(
  ctx: Pick<ToolContext, "fetch" | "accounts">,
  accounts: readonly GoogleAccount[],
  from: Date,
  to: Date,
  empty: string,
): Promise<string> {
  const outcomes = await fromEachAccount(accounts, "calendar", (account) =>
    listEvents(clientFor(ctx, account), from, to),
  );
  const events = successes(outcomes)
    .flatMap(({ account, value }) => value.map((event) => ({ account, event })))
    .sort((a, b) => startsAt(a.event) - startsAt(b.event));
  const lines = events
    .slice(0, MAX_EVENTS_SHOWN)
    .map(({ account, event }) => describeEvent(account, event));
  if (events.length > MAX_EVENTS_SHOWN) {
    lines.push(`(${events.length - MAX_EVENTS_SHOWN} more events not shown.)`);
  }
  const failures = describeFailures(outcomes);
  if (events.length === 0) {
    // "No events" must not sound complete when an account is missing.
    lines.push(
      failures.length ? `${empty.replace(/\.$/, "")} in the accounts that could be read.` : empty,
    );
  }
  return [...lines, ...failures].join("\n");
}
