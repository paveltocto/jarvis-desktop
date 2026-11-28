/**
 * Choosing among several Google accounts. Reads cover every account unless
 * one is named; anything that changes an account never guesses which.
 */
import { InvalidInput } from "../data/records";
import type { GoogleAccount, ToolContext } from "../tools/types";

/** What an account must have been allowed to do. */
export type Permission = "mailRead" | "mailSend" | "calendar";

const PERMISSION_LABELS: Record<Permission, string> = {
  mailRead: "reading Gmail",
  mailSend: "sending email",
  calendar: "using the calendar",
};

/** One account's connection, as the Gmail and Calendar clients need it. */
export type GoogleClient = Pick<ToolContext, "fetch" | "accounts"> & { accountId: string };

export const clientFor = (
  ctx: Pick<ToolContext, "fetch" | "accounts">,
  account: GoogleAccount,
): GoogleClient => ({ fetch: ctx.fetch, accounts: ctx.accounts, accountId: account.id });

export const accountLabel = (account: GoogleAccount): string =>
  account.alias ? `${account.alias} (${account.email})` : account.email;

const listed = (accounts: readonly GoogleAccount[]): string =>
  accounts.map(accountLabel).join(", ");

export async function connectedAccounts(
  ctx: Pick<ToolContext, "accounts">,
): Promise<GoogleAccount[]> {
  const accounts = await ctx.accounts.googleAccounts();
  if (accounts.length === 0) {
    throw new Error("Google is not connected: the user can add an account in Settings › Services.");
  }
  return accounts;
}

/** The account with this email or alias. */
export function findAccount(accounts: readonly GoogleAccount[], selector: string): GoogleAccount {
  const wanted = selector.trim().toLowerCase();
  const found = accounts.find(
    (account) => account.email.toLowerCase() === wanted || account.alias?.toLowerCase() === wanted,
  );
  if (!found) {
    throw new InvalidInput(
      `There is no Google account "${selector}". Connected: ${listed(accounts)}.`,
    );
  }
  return found;
}

export function requirePermission(account: GoogleAccount, permission: Permission): void {
  if (!account[permission]) {
    throw new Error(
      `${accountLabel(account)} has not allowed ${PERMISSION_LABELS[permission]}. The user can reconnect it in Settings › Services and tick every permission.`,
    );
  }
}

/** The named account, or all of them. */
export function readAccounts(accounts: GoogleAccount[], selector: string): GoogleAccount[] {
  return selector ? [findAccount(accounts, selector)] : accounts;
}

/** The account to send or create with: the named one, else the default. */
export function writeAccount(
  accounts: readonly GoogleAccount[],
  selector: string,
  permission: Permission,
): GoogleAccount {
  const account = selector
    ? findAccount(accounts, selector)
    : accounts.find((item) => item.isDefault);
  if (!account) {
    throw new InvalidInput(
      `Several Google accounts are connected and none is the default (${listed(accounts)}). Ask the user which one to use and pass it as account.`,
    );
  }
  requirePermission(account, permission);
  return account;
}

/** The account a message or event id belongs to. Ids mean nothing in another account. */
export function ownerAccount(
  accounts: readonly GoogleAccount[],
  selector: string,
  permission: Permission,
): GoogleAccount {
  if (!selector && accounts.length > 1) {
    throw new InvalidInput(
      "account is required when several Google accounts are connected: use the one shown next to the id.",
    );
  }
  const account = selector ? findAccount(accounts, selector) : accounts[0];
  if (!account) throw new InvalidInput("account is required.");
  requirePermission(account, permission);
  return account;
}

export type Outcome<T> =
  { account: GoogleAccount; value: T } | { account: GoogleAccount; error: string };

/** Asks every account at once. One that fails does not hide the others. */
export function fromEachAccount<T>(
  accounts: readonly GoogleAccount[],
  permission: Permission,
  read: (account: GoogleAccount) => Promise<T>,
): Promise<Outcome<T>[]> {
  return Promise.all(
    accounts.map(async (account): Promise<Outcome<T>> => {
      try {
        requirePermission(account, permission);
        return { account, value: await read(account) };
      } catch (error) {
        return { account, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

export function describeFailures<T>(outcomes: readonly Outcome<T>[]): string[] {
  return outcomes.flatMap((outcome) =>
    "error" in outcome ? [`${accountLabel(outcome.account)}: Not available: ${outcome.error}`] : [],
  );
}

/** Throws when no account could be read, so that is never reported as "nothing found". */
export function successes<T>(
  outcomes: readonly Outcome<T>[],
): { account: GoogleAccount; value: T }[] {
  const read = outcomes.filter(
    (outcome): outcome is { account: GoogleAccount; value: T } => "value" in outcome,
  );
  if (read.length === 0) throw new Error(describeFailures(outcomes).join("\n"));
  return read;
}

/** What the model is told about the accounts at the start of a session. */
export function formatAccountsForPrompt(accounts: readonly GoogleAccount[]): string {
  if (accounts.length === 0) return "";
  const names = accounts.map(
    (account) =>
      `${accountLabel(account)}${account.isDefault && accounts.length > 1 ? " [default for sending]" : ""}`,
  );
  return `Connected Google accounts: ${names.join(", ")}. Mail and calendar reads cover all of them unless the user names one; say which account each result is from.`;
}
