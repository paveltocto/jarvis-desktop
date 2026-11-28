/* eslint-disable @typescript-eslint/no-non-null-assertion -- a missing value should fail the test */
import { describe, expect, it, vi } from "vitest";
import { MAX_EVENTS_SHOWN } from "../../google/calendar-report";
import { googleAccount, googleAccounts, testContext } from "../testing/context";
import type { Approval } from "../types";
import { gmailControl } from "./gmail-control";
import { googleCalendar } from "./google-calendar";

const home = googleAccount("home", { alias: "personal" });
const work = googleAccount("work", { alias: "work", isDefault: true });
const accounts = googleAccounts(home, work);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokenOf = (init: RequestInit | undefined) =>
  new Headers(init?.headers).get("Authorization")?.replace("Bearer token-", "") ?? "";

function approvals() {
  const asked: Approval[] = [];
  return { asked, request: async (item: Approval) => void asked.push(item) };
}

/** Answers Gmail searches with one message per account; `broken` accounts fail. */
function mailbox(...broken: string[]) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const who = tokenOf(init);
    if (broken.includes(who)) return json({ error: { message: "expired" } }, 401);
    return String(url).includes("?maxResults")
      ? json({ messages: [{ id: `m-${who}` }] })
      : json({ id: `m-${who}`, payload: { headers: [{ name: "Subject", value: who }] } });
  });
}

describe("gmail_control with several accounts", () => {
  it("reads every account and says which each message is from", async () => {
    const result = await gmailControl.execute(
      { action: "unread" },
      testContext({ fetch: mailbox(), accounts }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toMatch(
      /personal \(home@x\.test\):\n.*account home@x\.test, message_id m-home/,
    );
    expect(result.output).toMatch(
      /work \(work@x\.test\):\n.*account work@x\.test, message_id m-work/,
    );
  });

  it("reads only the named account", async () => {
    const fetch = mailbox();
    await gmailControl.execute(
      { action: "unread", account: "work" },
      testContext({ fetch, accounts }),
    );
    expect(fetch.mock.calls.every(([, init]) => tokenOf(init) === "work")).toBe(true);
  });

  it("keeps the working account when another fails", async () => {
    const result = await gmailControl.execute(
      { action: "unread" },
      testContext({ fetch: mailbox("work"), accounts }),
    );
    expect(result).toMatchObject({
      ok: true,
      output: expect.stringContaining("work (work@x.test): Not available: Gmail returned HTTP 401"),
    });
  });

  it("fails, rather than finding nothing, when every account fails", async () => {
    const result = await gmailControl.execute(
      { action: "unread" },
      testContext({ fetch: mailbox("home", "work"), accounts }),
    );
    expect(result.ok).toBe(false);
  });

  it("needs the account to read a message", async () => {
    const result = await gmailControl.execute(
      { action: "read", message_id: "m1" },
      testContext({ accounts }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });

  it("shows the sending account and sends with its token only", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ id: "1" }));
    const ui = approvals();
    await gmailControl.execute(
      { action: "send", account: "personal", to: "a@b.test", body: "hi" },
      testContext({ fetch, accounts, approvals: ui }),
    );
    expect(ui.asked[0]?.title).toBe("Send an email from personal (home@x.test) to a@b.test?");
    expect(ui.asked[0]?.detail).toMatch(/^From: home@x\.test\n/);
    expect(fetch).not.toHaveBeenCalled();
    await ui.asked[0]!.run();
    expect(tokenOf(fetch.mock.calls[0]?.[1])).toBe("home");
  });

  it("asks which account when there is no default", async () => {
    const ui = approvals();
    const result = await gmailControl.execute(
      { action: "send", to: "a@b.test", body: "hi" },
      testContext({
        accounts: googleAccounts(home, { ...work, isDefault: false }),
        approvals: ui,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(ui.asked).toHaveLength(0);
  });

  it("does not fall back to another account if this one is disconnected while waiting", async () => {
    let connected = true;
    const fetch = vi.fn(async () => json({ id: "1" }));
    const ui = approvals();
    await gmailControl.execute(
      { action: "send", to: "a@b.test", body: "hi" },
      testContext({
        fetch,
        approvals: ui,
        accounts: {
          googleAccounts: async () => [home, work],
          accessToken: async (_provider, id) => {
            if (!connected) throw new Error("not connected anymore");
            return `token-${id}`;
          },
        },
      }),
    );
    connected = false;
    await expect(ui.asked[0]!.run()).rejects.toThrow("not connected anymore");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("google_calendar with several accounts", () => {
  const event = (id: string, hour: number) => ({
    id,
    summary: id,
    start: { dateTime: `2026-01-02T${String(hour).padStart(2, "0")}:00:00Z` },
  });

  it("merges the calendars by start time", async () => {
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      json({
        items: tokenOf(init) === "home" ? [event("a", 9), event("c", 15)] : [event("b", 12)],
      });
    const result = await googleCalendar.execute(
      { action: "list" },
      testContext({ fetch, accounts }),
    );
    if (!result.ok) throw new Error(result.error);
    expect([...result.output.matchAll(/event_id (\w)/g)].map((match) => match[1])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("says how many events it left out", async () => {
    const items = Array.from({ length: 25 }, (_, i) => event(`e${i}`, i % 24));
    const result = await googleCalendar.execute(
      { action: "list" },
      testContext({ fetch: async () => json({ items }), accounts }),
    );
    expect(result).toMatchObject({
      output: expect.stringContaining(`(${50 - MAX_EVENTS_SHOWN} more events not shown.)`),
    });
  });

  it("creates and deletes in the chosen account", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ id: "e1", summary: "Dentist" }),
    );
    const ui = approvals();
    const ctx = testContext({ fetch, accounts, approvals: ui });
    await googleCalendar.execute(
      { action: "create", summary: "Call", start: "2026-01-02T10:00" },
      ctx,
    );
    await googleCalendar.execute({ action: "delete", event_id: "e1", account: "personal" }, ctx);
    expect(ui.asked.map((item) => item.title)).toEqual([
      'Add "Call" to the calendar of work (work@x.test)?',
      'Delete "Dentist" from the calendar of personal (home@x.test)?',
    ]);
    for (const item of ui.asked) await item.run();
    expect(fetch.mock.calls.map(([, init]) => tokenOf(init))).toEqual(["home", "work", "home"]);
  });
});
