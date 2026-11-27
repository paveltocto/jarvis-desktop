import { describe, expect, it } from "vitest";
import { testContext } from "../testing/context";
import { jarvisUiControl } from "./jarvis-ui-control";

function widgetsFake(initial: Record<string, boolean>) {
  const state = { ...initial };
  return {
    state,
    widgets: {
      list: () => Object.entries(state).map(([id, visible]) => ({ id, visible })),
      setVisible: async (id: string, visible: boolean) => {
        state[id] = visible;
      },
    },
  };
}

describe("jarvis_ui_control", () => {
  it("shows a widget and reports it", async () => {
    const fake = widgetsFake({ clock: true, goals: false });
    const result = await jarvisUiControl.execute(
      { action: "show", widget: "goals" },
      testContext(fake),
    );
    expect(fake.state.goals).toBe(true);
    expect(result).toEqual({ ok: true, output: "Goals widget shown." });
  });

  it("lists the widgets", async () => {
    const fake = widgetsFake({ clock: true, goals: false });
    const result = await jarvisUiControl.execute({ action: "list" }, testContext(fake));
    expect(result).toEqual({ ok: true, output: "clock: shown\ngoals: hidden" });
  });

  it("rejects an unknown widget instead of pretending", async () => {
    const fake = widgetsFake({ clock: true });
    const result = await jarvisUiControl.execute(
      { action: "hide", widget: "radio" },
      testContext(fake),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(fake.state.clock).toBe(true);
  });
});
