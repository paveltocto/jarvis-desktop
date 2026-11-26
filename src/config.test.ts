import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings } from "./config";

describe("parseSettings", () => {
  it("returns defaults for missing or malformed data", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nope")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values and drops invalid ones", () => {
    expect(
      parseSettings({
        activationMode: "push_to_talk",
        wakeWordThreshold: 2,
        voice: "Robot",
        liveModel: "  custom-model ",
        inactivityTimeoutMs: 100,
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      activationMode: "push_to_talk",
      wakeWordThreshold: 0.99,
      liveModel: "custom-model",
    });
  });
});
