/* eslint-disable @typescript-eslint/no-non-null-assertion -- a missing value should fail the test */
import { describe, expect, it } from "vitest";
import { eventTimes } from "./calendar";
import { decodeBase64Url, rawMessage } from "./gmail";

describe("rawMessage", () => {
  const decode = (raw: string) => decodeBase64Url(raw);

  it("keeps a subject with line breaks on one header", () => {
    const message = decode(rawMessage("a@b.test", "Hi\r\nBcc: x@y.test", "body"));
    expect(message).not.toMatch(/^Bcc:/m);
    expect(message).toMatch(/^To: a@b\.test\r\nSubject: =\?UTF-8\?B\?/);
  });

  it("encodes accents in the subject and body", () => {
    const message = decode(rawMessage("a@b.test", "Reunión", "Mañana"));
    const [headers, body] = message.split("\r\n\r\n");
    const word = /=\?UTF-8\?B\?([^?]+)\?=/.exec(headers!)![1]!;
    expect(decodeBase64Url(word)).toBe("Reunión");
    expect(decodeBase64Url(body!)).toBe("Mañana");
  });

  it("rejects a recipient with line breaks", () => {
    expect(() => rawMessage("a@b.test\nBcc: c@d.test", "s", "b")).toThrow();
  });
});

describe("eventTimes", () => {
  it("makes an all-day event with an exclusive end date", () => {
    expect(eventTimes("2026-02-28", "", "UTC")).toEqual({
      start: { date: "2026-02-28" },
      end: { date: "2026-03-01" },
    });
  });

  it("defaults to one hour", () => {
    const times = eventTimes("2026-03-05T14:30:00Z", "", "UTC");
    expect(times.end.dateTime).toBe("2026-03-05T15:30:00.000Z");
  });

  it("adds the seconds Google needs", () => {
    const times = eventTimes("2026-03-05T14:30", "2026-03-05T16:00", "America/Lima");
    expect(times.start).toEqual({ dateTime: "2026-03-05T14:30:00", timeZone: "America/Lima" });
    expect(times.end.dateTime).toBe("2026-03-05T16:00:00");
  });

  it("rejects an end before the start and free text", () => {
    expect(() => eventTimes("2026-03-05T14:30", "2026-03-05T13:00", "UTC")).toThrow();
    expect(() => eventTimes("tomorrow", "", "UTC")).toThrow();
  });
});
