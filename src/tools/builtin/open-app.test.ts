import { describe, expect, it, vi } from "vitest";
import { testContext } from "../testing/context";
import { openApp } from "./open-app";

describe("open_app", () => {
  it("opens the app through the platform layer", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const result = await openApp.execute(
      { app_name: " Safari " },
      testContext({ system: { ...testContext().system, openApp: open } }),
    );
    expect(open).toHaveBeenCalledWith("Safari");
    expect(result).toEqual({ ok: true, output: "Opened Safari." });
  });

  it("reports the platform error instead of success", async () => {
    const open = vi
      .fn()
      .mockRejectedValue({ kind: "failed", message: "Unable to find application named 'Nope'" });
    const result = await openApp.execute(
      { app_name: "Nope" },
      testContext({ system: { ...testContext().system, openApp: open } }),
    );
    expect(result).toEqual({
      ok: false,
      code: "failed",
      error: "Could not open Nope: Unable to find application named 'Nope'",
    });
  });

  it("rejects an empty name", async () => {
    const result = await openApp.execute({ app_name: "  " }, testContext());
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
});
