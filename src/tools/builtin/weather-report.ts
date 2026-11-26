import type { ToolDefinition } from "../types";
import { fail, ok } from "../types";

const TIMEOUT_MS = 8_000;

interface WttrResponse {
  current_condition?: {
    temp_C?: string;
    FeelsLikeC?: string;
    humidity?: string;
    windspeedKmph?: string;
    weatherDesc?: { value?: string }[];
  }[];
  nearest_area?: { areaName?: { value?: string }[]; country?: { value?: string }[] }[];
}

/** Ported from legacy `weather_report` (actions/weather_report.py). Uses wttr.in, no API key. */
export const weatherReport: ToolDefinition = {
  name: "weather_report",
  description:
    "Gets the current weather for a city: conditions, temperature, feels-like, humidity and wind.",
  parameters: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: "City name, optionally with country, e.g. 'Lima' or 'Paris, France'.",
      },
    },
    required: ["city"],
  },
  platforms: ["macos", "windows", "linux", "other"],
  async execute(args, ctx) {
    const city = typeof args.city === "string" ? args.city.trim() : "";
    if (!city) return fail("invalid_arguments", "city must be a non-empty string.");

    let data: WttrResponse;
    try {
      const response = await ctx.fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return fail("failed", `Weather service returned HTTP ${response.status}.`);
      data = (await response.json()) as WttrResponse;
    } catch (error) {
      return fail(
        "failed",
        `Weather service unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const current = data.current_condition?.[0];
    if (!current?.temp_C) return fail("failed", `No weather data for "${city}".`);
    const area = data.nearest_area?.[0];
    const place =
      [area?.areaName?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(", ") || city;
    const condition = current.weatherDesc?.[0]?.value?.trim() || "unknown conditions";
    return ok(
      `${place}: ${condition}, ${current.temp_C}°C (feels like ${current.FeelsLikeC ?? "?"}°C), ` +
        `humidity ${current.humidity ?? "?"}%, wind ${current.windspeedKmph ?? "?"} km/h.`,
    );
  },
};
