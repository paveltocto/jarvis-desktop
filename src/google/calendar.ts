/** The parts of the Google Calendar REST API the tools use (primary calendar). */
import { InvalidInput } from "../data/records";
import { requestJson } from "../net/json-api";
import type { ToolContext } from "../tools/types";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const HOUR_MS = 60 * 60 * 1000;

type Client = Pick<ToolContext, "fetch" | "accounts">;

export interface EventTime {
  /** All-day events. */
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id: string;
  summary?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
}

export interface NewEvent {
  summary: string;
  location?: string;
  start: EventTime;
  end: EventTime;
}

async function call<T>(
  client: Client,
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
): Promise<T | null> {
  const token = await client.accounts.accessToken("google");
  return requestJson<T>(client.fetch, `${API}${path}`, {
    service: "Google Calendar",
    token,
    method,
    ...(body === undefined ? {} : { body }),
  });
}

export async function listEvents(client: Client, from: Date, to: Date): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "25",
  });
  return (await call<{ items?: CalendarEvent[] }>(client, `?${params}`))?.items ?? [];
}

export async function getEvent(client: Client, id: string): Promise<CalendarEvent> {
  const event = await call<CalendarEvent>(client, `/${encodeURIComponent(id)}`);
  if (!event) throw new Error("Google Calendar sent no event.");
  return event;
}

export async function createEvent(client: Client, event: NewEvent): Promise<void> {
  await call(client, "", "POST", event);
}

export async function deleteEvent(client: Client, id: string): Promise<void> {
  await call(client, `/${encodeURIComponent(id)}`, "DELETE");
}

export function describeWhen(time: EventTime | undefined): string {
  if (time?.date) return `${time.date} (all day)`;
  if (!time?.dateTime) return "unknown time";
  return new Date(time.dateTime).toLocaleString("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function describeEvent(event: CalendarEvent): string {
  const place = event.location ? ` at ${event.location}` : "";
  return `- ${describeWhen(event.start)}: ${event.summary || "(no title)"}${place} [event_id ${event.id}]`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function instant(value: string, field: string): Date {
  const date = new Date(value);
  if (!DATE_TIME.test(value) || Number.isNaN(date.getTime())) {
    throw new InvalidInput(`${field} must look like 2026-03-05T14:30 (or 2026-03-05 for all day).`);
  }
  return date;
}

/**
 * Builds the start and end of a new event. A date alone makes an all-day
 * event; `end` defaults to one day or one hour later.
 */
export function eventTimes(
  start: string,
  end: string,
  timeZone: string,
): { start: EventTime; end: EventTime } {
  if (DAY.test(start)) {
    if (end && (!DAY.test(end) || end < start)) {
      throw new InvalidInput("end must be a date on or after start.");
    }
    // Google's end date is exclusive; the user's is the last day.
    return { start: { date: start }, end: { date: nextDay(end || start) } };
  }
  const from = instant(start, "start");
  const to = end ? instant(end, "end") : new Date(from.getTime() + HOUR_MS);
  if (to <= from) throw new InvalidInput("end must be after start.");
  return {
    start: { dateTime: withSeconds(start), timeZone },
    end: { dateTime: end ? withSeconds(end) : to.toISOString(), timeZone },
  };
}

function withSeconds(value: string): string {
  return value.replace(/^(.{16})(?!:)/, "$1:00");
}
