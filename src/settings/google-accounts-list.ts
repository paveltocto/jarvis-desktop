/** The connected Google accounts in Settings › Services. */
import type { GoogleAccount } from "../tools/types";
import { button } from "./button";
import { MAX_GOOGLE_ACCOUNTS } from "./services";

export interface GoogleAccountsBackend {
  googleAccounts(): Promise<GoogleAccount[]>;
  googleConnect(loginHint: string | null): Promise<{ account: GoogleAccount; isNew: boolean }>;
  googleDisconnect(id: string): Promise<unknown>;
  googleUpdate(id: string, alias: string | null, makeDefault: boolean): Promise<unknown>;
}

interface Messages {
  status(text: string): void;
  error(text: string): void;
}

/** Permissions the account did not grant, for the warning under its name. */
export function missingPermissions(account: GoogleAccount): string[] {
  return [
    ...(account.mailRead ? [] : ["reading mail"]),
    ...(account.mailSend ? [] : ["sending mail"]),
    ...(account.calendar ? [] : ["calendar"]),
  ];
}

/** What to say after a sign-in, which may not be the account that was meant. */
export function connectMessage(
  result: { account: GoogleAccount; isNew: boolean },
  loginHint: string | null,
): string {
  const { email } = result.account;
  if (loginHint && loginHint.toLowerCase() !== email.toLowerCase()) {
    return `You signed in as ${email}, not ${loginHint}. ${result.isNew ? "It was added as another account" : "It was reconnected"}; ${loginHint} did not change.`;
  }
  return result.isNew ? `${email} added.` : `${email} reconnected.`;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

export class GoogleAccountsList {
  readonly element = document.createElement("div");
  readonly #list = document.createElement("ul");
  readonly #note = document.createElement("p");
  readonly #add: HTMLButtonElement;

  /** `saveFields` stores the OAuth client typed above before signing in. */
  constructor(
    private readonly backend: GoogleAccountsBackend,
    private readonly messages: Messages,
    private readonly saveFields: () => Promise<void>,
  ) {
    this.element.className = "service";
    this.#list.className = "account-list";
    this.#note.className = "muted small";
    this.#add = button("Add account…", "secondary-button", () => this.#connect(null));
    this.element.append(this.#list, this.#note, this.#add);
  }

  async refresh(): Promise<void> {
    const accounts = await this.backend.googleAccounts();
    this.#list.replaceChildren(...accounts.map((account) => this.#row(account, accounts.length)));
    this.#add.hidden = accounts.length >= MAX_GOOGLE_ACCOUNTS;
    this.#note.textContent =
      accounts.length === 0
        ? "No Google accounts connected."
        : accounts.some((account) => account.isDefault)
          ? ""
          : "No default account: JARVIS will ask which one to send from.";
    this.#note.hidden = !this.#note.textContent;
  }

  /** Runs an action, shows what happened and redraws the accounts. */
  async #run(action: () => Promise<string>): Promise<void> {
    try {
      this.messages.status(await action());
    } catch (error) {
      this.messages.error(error instanceof Error ? error.message : String(error));
    }
    await this.refresh().catch((error: unknown) => this.messages.error(String(error)));
  }

  #connect(loginHint: string | null): Promise<void> {
    return this.#run(async () => {
      await this.saveFields();
      this.messages.status("Finish signing in in your browser…");
      return connectMessage(await this.backend.googleConnect(loginHint), loginHint);
    });
  }

  #row(account: GoogleAccount, count: number): HTMLElement {
    const row = document.createElement("li");
    row.className = "account";

    const alias = document.createElement("input");
    alias.type = "text";
    alias.maxLength = 30;
    alias.value = account.alias ?? "";
    alias.placeholder = "Short name, e.g. work";
    alias.setAttribute("aria-label", `Short name for ${account.email}`);
    alias.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      // Enter would submit the Settings form and close it.
      event.preventDefault();
      alias.blur();
    });
    alias.addEventListener("change", () => {
      void this.#run(async () => {
        await this.backend.googleUpdate(account.id, alias.value.trim() || null, false);
        return `Short name saved for ${account.email}.`;
      });
    });

    row.append(span("account-email", account.email), alias);

    const missing = missingPermissions(account);
    if (missing.length) {
      row.append(span("error small", `Not allowed: ${missing.join(", ")}. Reconnect to allow.`));
    }

    const actions = document.createElement("div");
    actions.className = "account-actions";
    if (count > 1) {
      const label = document.createElement("label");
      label.className = "check-row small";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "google-default";
      radio.checked = account.isDefault;
      radio.addEventListener("change", () => {
        void this.#run(async () => {
          // Send what the field shows: it may have been edited just before this click.
          await this.backend.googleUpdate(account.id, alias.value.trim() || null, true);
          return `${account.email} is now the default for sending.`;
        });
      });
      label.append(radio, "Default for sending");
      actions.append(label);
    }
    const disconnect = button("Disconnect", "text-button danger", () =>
      this.#run(async () => {
        await this.backend.googleDisconnect(account.id);
        return `${account.email} disconnected from this computer.`;
      }),
    );
    disconnect.setAttribute("aria-label", `Disconnect ${account.email}`);
    const reconnect = button("Reconnect…", "text-button", () => this.#connect(account.email));
    reconnect.setAttribute("aria-label", `Reconnect ${account.email}`);
    actions.append(disconnect, reconnect);
    row.append(actions);
    return row;
  }
}
