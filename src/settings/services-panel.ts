/**
 * Draws Settings › Services. Stored values are never read back: the panel
 * only knows whether each one exists.
 */
import type { OAuthProvider } from "../tools/types";
import { SERVICE_GROUPS, serviceProblem, type ServiceSecret } from "./services";

export interface ServicesBackend {
  exists(secret: ServiceSecret): Promise<boolean>;
  set(secret: ServiceSecret, value: string): Promise<unknown>;
  delete(secret: ServiceSecret): Promise<unknown>;
  status(provider: OAuthProvider): Promise<{ configured: boolean; connected: boolean }>;
  connect(provider: OAuthProvider): Promise<unknown>;
  disconnect(provider: OAuthProvider): Promise<unknown>;
}

export interface ServicesMessages {
  status(text: string): void;
  error(text: string): void;
}

function button(label: string, className: string, run: () => Promise<void>): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", () => {
    element.disabled = true;
    void run().finally(() => (element.disabled = false));
  });
  return element;
}

export class ServicesPanel {
  readonly #inputs = new Map<ServiceSecret, HTMLInputElement>();
  readonly #refreshers: (() => Promise<void>)[] = [];

  constructor(
    container: HTMLElement,
    private readonly backend: ServicesBackend,
    private readonly messages: ServicesMessages,
  ) {
    container.append(...SERVICE_GROUPS.map((group) => this.#group(group)));
  }

  /** Clears the inputs and shows what is stored. */
  async refresh(): Promise<void> {
    for (const input of this.#inputs.values()) input.value = "";
    await Promise.all(this.#refreshers.map((refresh) => refresh()));
  }

  /** Stores what was typed. Throws without saving anything if a value is wrong. */
  async save(): Promise<void> {
    const values = new Map(
      [...this.#inputs]
        .map(([secret, input]) => [secret, input.value.trim()] as const)
        .filter(([, value]) => value),
    );
    const problem = serviceProblem(values);
    if (problem) throw new Error(problem);
    for (const [secret, value] of values) await this.backend.set(secret, value);
    for (const input of this.#inputs.values()) input.value = "";
  }

  #group(group: (typeof SERVICE_GROUPS)[number]): HTMLElement {
    const section = document.createElement("section");
    section.className = "service";
    const title = document.createElement("h3");
    title.className = "section-title";
    title.textContent = group.title;
    const hint = document.createElement("p");
    hint.className = "muted small";
    hint.textContent = group.hint;
    section.append(title, hint, ...group.fields.map((field) => this.#field(field)));
    if (group.oauth) section.append(this.#account(group.title, group.oauth));
    return section;
  }

  #field(field: (typeof SERVICE_GROUPS)[number]["fields"][number]): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    const heading = document.createElement("div");
    heading.className = "field-heading";
    const label = document.createElement("label");
    label.htmlFor = `service-${field.secret}`;
    label.textContent = field.label;
    const input = document.createElement("input");
    input.id = label.htmlFor;
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    const remove = button("Remove", "text-button danger", async () => {
      try {
        await this.backend.delete(field.secret);
        await this.refresh();
        this.messages.status(`${field.label} removed.`);
      } catch (error) {
        this.messages.error(`Could not remove it: ${String(error)}`);
      }
    });
    remove.setAttribute("aria-label", `Remove ${field.label}`);
    heading.append(label, remove);
    wrapper.append(heading, input);
    this.#inputs.set(field.secret, input);
    this.#refreshers.push(async () => {
      const stored = await this.backend.exists(field.secret);
      input.placeholder = stored ? "Saved in the Keychain (leave empty to keep)" : "Not set";
      remove.hidden = !stored;
    });
    return wrapper;
  }

  #account(name: string, provider: OAuthProvider): HTMLElement {
    const row = document.createElement("div");
    row.className = "service-account";
    const state = document.createElement("span");
    state.className = "muted small";
    const connect = button("Connect…", "secondary-button", async () => {
      try {
        await this.save();
        this.messages.status("Finish signing in in your browser…");
        await this.backend.connect(provider);
        await this.refresh();
        this.messages.status(`${name} connected.`);
      } catch (error) {
        this.messages.error(error instanceof Error ? error.message : String(error));
      }
    });
    const disconnect = button("Disconnect", "text-button danger", async () => {
      try {
        await this.backend.disconnect(provider);
        await this.refresh();
        this.messages.status(`${name} disconnected.`);
      } catch (error) {
        this.messages.error(String(error));
      }
    });
    row.append(state, disconnect, connect);
    this.#refreshers.push(async () => {
      const { connected } = await this.backend.status(provider);
      state.textContent = connected ? "Connected" : "Not connected";
      disconnect.hidden = !connected;
      connect.textContent = connected ? "Reconnect…" : "Connect…";
    });
    return row;
  }
}
