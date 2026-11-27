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

/** The goal the widget features: the first unfinished one, or the first of all. */
export function featuredGoal(goals: GoalSummary[]): GoalSummary | null {
  return goals.find((goal) => goal.progress < 100) ?? goals[0] ?? null;
}

/** "Today 11:30 AM", "Tomorrow 9:00 AM" or "Dec 15, 9:00 AM". */
export function formatDue(dueAtMs: number, now: Date, timeZone?: string): string {
  const zone: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  const due = new Date(dueAtMs);
  const day = (date: Date) => date.toLocaleDateString("en-US", zone);
  const time = due.toLocaleTimeString("en-US", { ...zone, hour: "numeric", minute: "2-digit" });
  if (day(due) === day(now)) return `Today ${time}`;
  // 36 hours after local noon is always the next calendar day, even across DST changes.
  const hour = Number(
    now.toLocaleTimeString("en-US", { ...zone, hour: "2-digit", hourCycle: "h23" }),
  );
  const tomorrow = new Date(now.getTime() + (36 - hour) * 3_600_000);
  if (day(due) === day(tomorrow)) return `Tomorrow ${time}`;
  const date = due.toLocaleDateString("en-US", { ...zone, month: "short", day: "numeric" });
  return `${date}, ${time}`;
}
