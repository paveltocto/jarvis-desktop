import { describe, expect, it, vi } from "vitest";
import { testContext } from "../testing/context";
import { shutdownJarvis } from "./shutdown-jarvis";

describe("shutdown_jarvis", () => {
  it("asks for confirmation and says the app has not closed yet", async () => {
    const requestQuit = vi.fn().mockResolvedValue(undefined);
    const result = await shutdownJarvis.execute({}, testContext({ app: { requestQuit } }));
    expect(requestQuit).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, output: expect.stringContaining("has not closed yet") });
  });

  it("reports a failure when the confirmation cannot be shown", async () => {
    const result = await shutdownJarvis.execute(
      {},
      testContext({ app: { requestQuit: () => Promise.reject(new Error("window missing")) } }),
    );
    expect(result).toEqual({ ok: false, code: "failed", error: "window missing" });
  });
});
