/** Widgets the main window can show. The order here is the order on screen. */
export const WIDGET_IDS = ["clock", "weather", "reminders", "goals"] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

export const WIDGET_TITLES: Record<WidgetId, string> = {
  clock: "Clock",
  weather: "Weather",
  reminders: "Reminders",
  goals: "Goals",
};

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && (WIDGET_IDS as readonly string[]).includes(value);
}

/** Keeps known widget ids, in catalog order, without duplicates. */
export function parseWidgetList(value: unknown): WidgetId[] {
  if (!Array.isArray(value)) return [];
  return WIDGET_IDS.filter((id) => value.includes(id));
}
