import { describe, expect, it } from "vitest";
import { googleAccount, googleAccounts, testContext } from "../testing/context";
import { morningBrief } from "./morning-brief";

describe("morning_brief", () => {
  it("says which sections could not be read instead of leaving them empty", async () => {
    const result = await morningBrief.execute({}, testContext());
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toMatch(/Weather:\nNot available: no city/);
    expect(result.output).toMatch(/Calendar today:\nNot available: Google is not connected/);
    expect(result.output).toMatch(/Unread email:\nNot available/);
    expect(result.output).toContain("No reminders left today.");
    expect(result.output).toContain("No goals.");
  });

  it("names the account that could not be read and keeps the others", async () => {
    const accounts = googleAccounts(googleAccount("home"), googleAccount("work"));
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const auth = new Headers(init?.headers).get("Authorization");
      return auth === "Bearer token-home"
        ? new Response(JSON.stringify({ items: [], messages: [] }))
        : new Response(JSON.stringify({ error: { message: "revoked" } }), { status: 401 });
    };
    const result = await morningBrief.execute({}, testContext({ fetch, accounts }));
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toContain("No more events today in the accounts that could be read.");
    expect(result.output).toContain("home@x.test:\nNo unread email");
    expect(result.output).toMatch(/work@x\.test: Not available: Gmail returned HTTP 401: revoked/);
  });
});
