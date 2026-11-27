import type { Goal } from "../data/records";

/** Time and date shown by the clock widget, in the given time zone (or the system one). */
export function formatClock(now: Date, timeZone?: string): { time: string; date: string } {
  const options: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  return {
    time: now.toLocaleTimeString("en-US", { ...options, hour: "2-digit", minute: "2-digit" }),
    date: now.toLocaleDateString("en-US", {
      ...options,
      weekday: "long",
      month: "long",
      day: "numeric",
    }),
  };
}

export interface GoalSummary {
  title: string;
  progress: number;
  deadline: string | null;
}

export function summarizeGoals(goals: Goal[] | null): GoalSummary[] {
  return (goals ?? []).map((goal) => ({
    title: goal.title,
    progress: goal.progress,
    deadline: goal.deadline,
  }));
}

/** Weather text is trimmed to a size that fits the small window. */
export const WEATHER_MAX_CHARS = 280;

export function clipWeather(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= WEATHER_MAX_CHARS ? flat : `${flat.slice(0, WEATHER_MAX_CHARS - 1)}…`;
}
