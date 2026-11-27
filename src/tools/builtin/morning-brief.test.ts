import { describe, expect, it } from "vitest";
import { testContext } from "../testing/context";
import { morningBrief } from "./morning-brief";

describe("morning_brief", () => {
  it("says which sections could not be read instead of leaving them empty", async () => {
    const result = await morningBrief.execute({}, testContext());
    if (!result.ok) throw new Error(result.error);
    expect(result.output).toMatch(/Weather:\nNot available: no city/);
    expect(result.output).toMatch(/Calendar today:\nNot available: not connected/);
    expect(result.output).toMatch(/Unread email:\nNot available/);
    expect(result.output).toContain("No reminders left today.");
    expect(result.output).toContain("No goals.");
  });
});
