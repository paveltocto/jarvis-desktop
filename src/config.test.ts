import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, shortcutLabel, VOICE_SHORTCUTS } from "./config";

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
        voiceShortcut: "Hyper+Banana",
      }),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      activationMode: "push_to_talk",
      wakeWordThreshold: 0.99,
      liveModel: "custom-model",
    });
  });
});

describe("widget settings", () => {
  it("keeps valid widgets and the weather city", () => {
    const parsed = parseSettings({ visibleWidgets: ["goals", "bogus"], weatherCity: "  Lima " });
    expect(parsed.visibleWidgets).toEqual(["goals"]);
    expect(parsed.weatherCity).toBe("Lima");
  });

  it("defaults to the clock and no city", () => {
    expect(parseSettings(null)).toMatchObject({ visibleWidgets: ["clock"], weatherCity: "" });
  });
});

describe("voice shortcut", () => {
  it("defaults to a preset that is not Option+Space", () => {
    expect(VOICE_SHORTCUTS.map((item) => item.accelerator)).toContain(
      DEFAULT_SETTINGS.voiceShortcut,
    );
    expect(DEFAULT_SETTINGS.voiceShortcut).not.toBe("Alt+Space");
  });

  it("keeps a stored preset", () => {
    expect(parseSettings({ voiceShortcut: "Alt+Space" }).voiceShortcut).toBe("Alt+Space");
  });

  it("labels shortcuts per OS", () => {
    expect(shortcutLabel("Control+Alt+Space", "macos")).toBe("⌃⌥ Space");
    expect(shortcutLabel("Control+Alt+Space", "windows")).toBe("Ctrl+Alt+Space");
    expect(shortcutLabel("Unknown+Key", "macos")).toBe("Unknown+Key");
  });
});
