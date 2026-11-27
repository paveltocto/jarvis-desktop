import { isWidgetId, WIDGET_IDS, WIDGET_TITLES } from "../../widgets/catalog";
import type { ToolDefinition } from "../types";
import { fail, ok } from "../types";

/** Ported from legacy `jarvis_ui_control` (ui.py). Legacy widget names are not kept; the ids come from the widget catalog. */
export const jarvisUiControl: ToolDefinition = {
  name: "jarvis_ui_control",
  description: `Shows, hides or lists the widgets in the JARVIS window. Widgets: ${WIDGET_IDS.join(", ")}. Use 'list' to see which are visible.`,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["show", "hide", "list"], description: "What to do." },
      widget: { type: "string", enum: [...WIDGET_IDS], description: "Widget to show or hide." },
    },
    required: ["action"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    if (args.action === "list") {
      return ok(
        ctx.widgets
          .list()
          .map((item) => `${item.id}: ${item.visible ? "shown" : "hidden"}`)
          .join("\n"),
      );
    }
    if (args.action !== "show" && args.action !== "hide") {
      return fail("invalid_arguments", 'action must be "show", "hide" or "list".');
    }
    if (!isWidgetId(args.widget)) {
      return fail("invalid_arguments", `widget must be one of: ${WIDGET_IDS.join(", ")}.`);
    }
    try {
      const visible = args.action === "show";
      await ctx.widgets.setVisible(args.widget, visible);
      return ok(`${WIDGET_TITLES[args.widget]} widget ${visible ? "shown" : "hidden"}.`);
    } catch (error) {
      return fail("failed", error instanceof Error ? error.message : String(error));
    }
  },
};
