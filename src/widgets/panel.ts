import type { DocumentStore } from "../data/document-store";
import type { GoalsDocument } from "../data/records";
import type { Weather } from "../tools/builtin/weather-report";
import type { ReminderApi } from "../tools/types";
import { WIDGET_IDS, WIDGET_TITLES, type WidgetId } from "./catalog";
import { featuredGoal, formatClock, formatDue, summarizeGoals } from "./logic";

export interface WidgetDeps {
  store: DocumentStore;
  reminders: ReminderApi;
  /** Returns the current weather for a city, or throws. */
  weather(city: string): Promise<Weather>;
}

const CLOCK_TICK_MS = 1_000;
const WEATHER_REFRESH_MS = 30 * 60 * 1000;

/**
 * Draws the visible widgets in the main window. Everything is built with
 * DOM calls and `textContent`, so stored text is never read as HTML.
 */
export class WidgetPanel {
  readonly #root: HTMLElement;
  readonly #deps: WidgetDeps;
  #bodies = new Map<WidgetId, HTMLElement>();
  /** Short text at the right of a widget title. */
  #metas = new Map<WidgetId, HTMLElement>();
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #weatherTimer: ReturnType<typeof setInterval> | null = null;
  #city = "";
  #visible: WidgetId[] = [];

  constructor(root: HTMLElement, deps: WidgetDeps) {
    this.#root = root;
    this.#deps = deps;
  }

  /** Rebuilds the panel for the given widgets. Keeps the order of the catalog. */
  render(visible: readonly WidgetId[], city: string): void {
    this.#stopTimers();
    this.#visible = WIDGET_IDS.filter((id) => visible.includes(id));
    this.#city = city;
    this.#bodies = new Map();
    this.#metas = new Map();
    // Clock and weather share a row; either takes all of it when alone.
    const paired = this.#visible.includes("clock") && this.#visible.includes("weather");
    this.#root.replaceChildren(
      ...this.#visible.map((id) => {
        const section = document.createElement("section");
        const half = paired && (id === "clock" || id === "weather");
        section.className = half ? "widget" : "widget wide";
        section.dataset.widget = id;
        const header = document.createElement("div");
        header.className = "widget-header";
        const title = document.createElement("h3");
        title.textContent = WIDGET_TITLES[id];
        const meta = document.createElement("span");
        meta.className = "widget-meta";
        this.#metas.set(id, meta);
        header.append(title, meta);
        const body = document.createElement("div");
        body.className = "widget-body";
        this.#bodies.set(id, body);
        section.append(header, body);
        return section;
      }),
    );
    this.#root.hidden = this.#visible.length === 0;
    this.refresh();
    if (this.#visible.includes("clock")) {
      this.#clockTimer = setInterval(() => this.#drawClock(), CLOCK_TICK_MS);
    }
    if (this.#visible.includes("weather")) {
      this.#weatherTimer = setInterval(() => void this.#drawWeather(), WEATHER_REFRESH_MS);
    }
  }

  /** Reloads the data widgets (reminders, goals, weather). */
  refresh(): void {
    if (this.#visible.includes("clock")) this.#drawClock();
    if (this.#visible.includes("reminders")) void this.#drawReminders();
    if (this.#visible.includes("goals")) void this.#drawGoals();
    if (this.#visible.includes("weather")) void this.#drawWeather();
  }

  stop(): void {
    this.#stopTimers();
  }

  #stopTimers(): void {
    if (this.#clockTimer !== null) clearInterval(this.#clockTimer);
    if (this.#weatherTimer !== null) clearInterval(this.#weatherTimer);
    this.#clockTimer = null;
    this.#weatherTimer = null;
  }

  #drawClock(): void {
    const body = this.#bodies.get("clock");
    if (!body) return;
    const { time, date } = formatClock(new Date());
    body.replaceChildren(line(time, "primary-line"), line(date, "secondary-line"));
  }

  async #drawReminders(): Promise<void> {
    const body = this.#bodies.get("reminders");
    if (!body) return;
    try {
      const pending = await this.#deps.reminders.list();
      const next = pending[0];
      this.#setMeta("reminders", pending.length > 1 ? `+${pending.length - 1} more` : "");
      body.replaceChildren(
        next
          ? itemRow(next.message, formatDue(next.dueAtMs, new Date()))
          : line("No pending reminders.", "secondary-line"),
      );
    } catch (error) {
      this.#setMeta("reminders", "");
      body.replaceChildren(line(`Could not load reminders: ${messageOf(error)}`, "error"));
    }
  }

  async #drawGoals(): Promise<void> {
    const body = this.#bodies.get("goals");
    if (!body) return;
    try {
      const goals = summarizeGoals(await this.#deps.store.read<GoalsDocument>("goals"));
      const goal = featuredGoal(goals);
      if (!goal) {
        this.#setMeta("goals", "");
        body.replaceChildren(line("No goals yet.", "secondary-line"));
        return;
      }
      const deadline = goal.deadline ? ` · due ${goal.deadline}` : "";
      this.#setMeta("goals", `${goal.progress}%${deadline}`);
      const bar = document.createElement("progress");
      bar.max = 100;
      bar.value = goal.progress;
      bar.setAttribute("aria-label", `Progress of ${goal.title}`);
      const others = goals.length > 1 ? `+${goals.length - 1} more` : "";
      body.replaceChildren(itemRow(goal.title, others), bar);
    } catch (error) {
      this.#setMeta("goals", "");
      body.replaceChildren(line(`Could not load goals: ${messageOf(error)}`, "error"));
    }
  }

  async #drawWeather(): Promise<void> {
    const body = this.#bodies.get("weather");
    if (!body) return;
    if (!this.#city) {
      body.replaceChildren(line("Set a city in Settings to see the weather.", "secondary-line"));
      return;
    }
    try {
      const weather = await this.#deps.weather(this.#city);
      const range =
        weather.highC !== null && weather.lowC !== null
          ? ` · H:${weather.highC}° L:${weather.lowC}°`
          : "";
      body.replaceChildren(
        line(`${weather.tempC}°C`, "primary-line"),
        line(weather.condition),
        line(`${weather.area}${range}`, "secondary-line"),
      );
    } catch (error) {
      body.replaceChildren(line(`Weather unavailable: ${messageOf(error)}`, "error"));
    }
  }

  #setMeta(id: WidgetId, text: string): void {
    const meta = this.#metas.get(id);
    if (meta) meta.textContent = text;
  }
}

function line(text: string, className?: string): HTMLParagraphElement {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  if (className) paragraph.className = className;
  return paragraph;
}

/** A title that truncates, with a short detail at the right. */
function itemRow(title: string, detail: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "item-row";
  const name = document.createElement("span");
  name.className = "item-title";
  name.textContent = title;
  name.title = title;
  const extra = document.createElement("span");
  extra.className = "item-detail";
  extra.textContent = detail;
  row.append(name, extra);
  return row;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
