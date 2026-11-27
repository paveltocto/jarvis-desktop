import type { DocumentStore } from "../data/document-store";
import type { GoalsDocument } from "../data/records";
import type { ReminderApi } from "../tools/types";
import { WIDGET_IDS, WIDGET_TITLES, type WidgetId } from "./catalog";
import { clipWeather, formatClock, summarizeGoals } from "./logic";

export interface WidgetDeps {
  store: DocumentStore;
  reminders: ReminderApi;
  /** Returns the weather text for a city, or throws. */
  weather(city: string): Promise<string>;
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
    this.#root.replaceChildren(
      ...this.#visible.map((id) => {
        const section = document.createElement("section");
        section.className = "widget";
        section.dataset.widget = id;
        const title = document.createElement("h3");
        title.textContent = WIDGET_TITLES[id];
        const body = document.createElement("div");
        body.className = "widget-body";
        this.#bodies.set(id, body);
        section.append(title, body);
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
    setLines(body, [time, date], "clock-time");
  }

  async #drawReminders(): Promise<void> {
    const body = this.#bodies.get("reminders");
    if (!body) return;
    try {
      const pending = await this.#deps.reminders.list();
      const lines = pending
        .slice(0, 5)
        .map(
          (item) =>
            `${new Date(item.dueAtMs).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${item.message}`,
        );
      setLines(body, lines.length ? lines : ["No pending reminders."]);
    } catch (error) {
      setLines(body, [`Could not load reminders: ${messageOf(error)}`], "error");
    }
  }

  async #drawGoals(): Promise<void> {
    const body = this.#bodies.get("goals");
    if (!body) return;
    try {
      const goals = summarizeGoals(await this.#deps.store.read<GoalsDocument>("goals"));
      const lines = goals.slice(0, 5).map((goal) => {
        const deadline = goal.deadline ? ` · due ${goal.deadline}` : "";
        return `${goal.title} · ${goal.progress}%${deadline}`;
      });
      setLines(body, lines.length ? lines : ["No goals yet."]);
    } catch (error) {
      setLines(body, [`Could not load goals: ${messageOf(error)}`], "error");
    }
  }

  async #drawWeather(): Promise<void> {
    const body = this.#bodies.get("weather");
    if (!body) return;
    if (!this.#city) {
      setLines(body, ["Set a city in Settings to see the weather."]);
      return;
    }
    try {
      setLines(body, [clipWeather(await this.#deps.weather(this.#city))]);
    } catch (error) {
      setLines(body, [`Weather unavailable: ${messageOf(error)}`], "error");
    }
  }
}

/** Replaces the body with one element per line. */
function setLines(body: HTMLElement, lines: string[], className?: string): void {
  body.replaceChildren(
    ...lines.map((line) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      if (className) paragraph.className = className;
      return paragraph;
    }),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
