import { describe, expect, it } from "vitest";
import { googleAccount } from "../tools/testing/context";
import {
  findAccount,
  formatAccountsForPrompt,
  fromEachAccount,
  ownerAccount,
  readAccounts,
  successes,
  writeAccount,
} from "./accounts";

const home = googleAccount("home", { alias: "Personal" });
const work = googleAccount("work", { alias: "Trabajo", isDefault: true });

describe("choosing an account", () => {
  it("finds one by email or alias, ignoring case", () => {
    expect(findAccount([home, work], "HOME@x.test")).toBe(home);
    expect(findAccount([home, work], " trabajo ")).toBe(work);
  });

  it("lists the connected accounts when the name is unknown", () => {
    expect(() => findAccount([home, work], "other")).toThrow(
      "Connected: Personal (home@x.test), Trabajo (work@x.test).",
    );
  });

  it("reads from every account unless one is named", () => {
    expect(readAccounts([home, work], "")).toEqual([home, work]);
    expect(readAccounts([home, work], "personal")).toEqual([home]);
  });

  it("writes with the named account, else the default", () => {
    expect(writeAccount([home, work], "", "mailSend")).toBe(work);
    expect(writeAccount([home, work], "personal", "mailSend")).toBe(home);
  });

  it("never guesses between accounts without a default", () => {
    const undecided = [home, { ...work, isDefault: false }];
    expect(() => writeAccount(undecided, "", "mailSend")).toThrow("none is the default");
  });

  it("does not switch accounts when the chosen one lacks the permission", () => {
    const accounts = [home, { ...work, mailSend: false }];
    expect(() => writeAccount(accounts, "", "mailSend")).toThrow("has not allowed sending email");
  });

  it("needs the account of an id when there are several", () => {
    expect(ownerAccount([home], "", "mailRead")).toBe(home);
    expect(() => ownerAccount([home, work], "", "mailRead")).toThrow("account is required");
  });
});

describe("reading several accounts", () => {
  it("reports an account without permission without asking it", async () => {
    const asked: string[] = [];
    const outcomes = await fromEachAccount(
      [home, { ...work, calendar: false }],
      "calendar",
      async (account) => void asked.push(account.id),
    );
    expect(asked).toEqual(["home"]);
    expect(outcomes[1]).toMatchObject({ error: expect.stringContaining("calendar") });
  });

  it("fails when none could be read", async () => {
    const outcomes = await fromEachAccount([home, work], "mailRead", () =>
      Promise.reject(new Error("offline")),
    );
    expect(() => successes(outcomes)).toThrow(
      "Personal (home@x.test): Not available: offline\nTrabajo (work@x.test): Not available: offline",
    );
  });
});

describe("formatAccountsForPrompt", () => {
  it("is empty without accounts", () => {
    expect(formatAccountsForPrompt([])).toBe("");
  });

  it("names the accounts and the default", () => {
    expect(formatAccountsForPrompt([home, work])).toContain(
      "Personal (home@x.test), Trabajo (work@x.test) [default for sending].",
    );
  });
});
