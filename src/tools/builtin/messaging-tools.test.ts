/* eslint-disable @typescript-eslint/no-non-null-assertion -- a missing value should fail the test */
import { describe, expect, it, vi } from "vitest";
import { googleAccount, googleAccounts, testContext } from "../testing/context";
import type { Approval } from "../types";
import { gmailControl } from "./gmail-control";
import { googleCalendar } from "./google-calendar";
import { unifiedCommunications } from "./unified-communications";

function approvals() {
  const asked: Approval[] = [];
  return { asked, request: async (item: Approval) => void asked.push(item) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const connected = googleAccounts(googleAccount("me", { isDefault: true }));

describe("unified_communications", () => {
  it("sends nothing on Telegram until the user confirms", async () => {
    const telegram = vi.fn().mockResolvedValue(undefined);
    const ui = approvals();
    const result = await unifiedCommunications.execute(
      { platform: "telegram", message: "hola" },
      testContext({ messaging: { telegram }, approvals: ui }),
    );
    expect(result).toMatchObject({ ok: true, output: expect.stringContaining("NOT done yet") });
    expect(telegram).not.toHaveBeenCalled();
    await ui.asked[0]!.run();
    expect(telegram).toHaveBeenCalledWith("hola");
  });

  it("fails when Discord is not set up or the webhook is not Discord's", async () => {
    for (const stored of [null, "https://evil.test/api/webhooks/1/x"]) {
      const result = await unifiedCommunications.execute(
        { platform: "discord", message: "x" },
        testContext({ secrets: { get: async () => stored }, approvals: approvals() }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("says that an email draft was not sent", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const result = await unifiedCommunications.execute(
      { platform: "email", recipient: "a@b.test", message: "x & y", subject: "s" },
      testContext({ web: { ...testContext().web, openUrl } }),
    );
    expect(openUrl).toHaveBeenCalledWith("mailto:a@b.test?subject=s&body=x%20%26%20y");
    expect(result).toMatchObject({ output: expect.stringContaining("NOT been sent") });
  });

  it("refuses recipients that would add addresses or headers", async () => {
    for (const recipient of ["a@b.test,c@d.test", "a@b.test?bcc=c@d.test", "a@b.test\nBcc: x"]) {
      const result = await unifiedCommunications.execute(
        { platform: "email", recipient, message: "x" },
        testContext(),
      );
      expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
  });
});

describe("gmail_control", () => {
  it("fails at once when Gmail is not connected", async () => {
    const ui = approvals();
    const result = await gmailControl.execute(
      { action: "send", to: "a@b.test", body: "hi" },
      testContext({ approvals: ui }),
    );
    expect(result.ok).toBe(false);
    expect(ui.asked).toHaveLength(0);
  });

  it("posts the email only after confirmation", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "1" }));
    const ui = approvals();
    await gmailControl.execute(
      { action: "send", to: "a@b.test", subject: "Saludos", body: "hola" },
      testContext({ fetch, accounts: connected, approvals: ui }),
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(ui.asked[0]!.run()).resolves.toBe("Email sent from me@x.test to a@b.test.");
    expect(fetch.mock.calls[0]?.[0]).toMatch(/\/messages\/send$/);
  });
});

describe("google_calendar", () => {
  it("lists events", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json({ items: [{ id: "e1", summary: "Dentist", start: { date: "2026-01-02" } }] }),
      );
    const result = await googleCalendar.execute(
      { action: "list" },
      testContext({ fetch, accounts: connected }),
    );
    expect(result).toMatchObject({
      output: "- 2026-01-02 (all day): Dentist [account me@x.test, event_id e1]",
    });
  });

  it("asks before deleting and shows which event", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ id: "e1", summary: "Dentist" }));
    const ui = approvals();
    await googleCalendar.execute(
      { action: "delete", event_id: "e1" },
      testContext({ fetch, accounts: connected, approvals: ui }),
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(ui.asked[0]?.title).toContain("Dentist");
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await ui.asked[0]!.run();
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("reports the API's error", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ error: { message: "API disabled" } }, 403));
    const result = await googleCalendar.execute(
      { action: "list" },
      testContext({ fetch, accounts: connected }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: "me@x.test: Not available: Google Calendar returned HTTP 403: API disabled.",
    });
  });
});
