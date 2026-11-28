import { describe, expect, it } from "vitest";
import { googleAccount } from "../tools/testing/context";
import { connectMessage, missingPermissions } from "./google-accounts-list";

describe("Google accounts in Settings", () => {
  it("names the permissions an account did not grant", () => {
    expect(missingPermissions(googleAccount("a"))).toEqual([]);
    expect(missingPermissions(googleAccount("a", { calendar: false, mailSend: false }))).toEqual([
      "sending mail",
      "calendar",
    ]);
  });

  it("says when the user signed in to a different account than the one reconnected", () => {
    const result = { account: googleAccount("b"), isNew: true };
    expect(connectMessage(result, "a@x.test")).toBe(
      "You signed in as b@x.test, not a@x.test. It was added as another account; a@x.test did not change.",
    );
    expect(connectMessage(result, null)).toBe("b@x.test added.");
    expect(connectMessage({ ...result, isNew: false }, "B@x.test")).toBe("b@x.test reconnected.");
  });
});
