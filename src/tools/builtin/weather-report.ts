import type { ToolContext, ToolDefinition } from "../types";
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
  /** Daily forecast; the first entry is today. */
  weather?: { maxtempC?: string; mintempC?: string }[];
}

export interface Weather {
  area: string;
  country: string | null;
  condition: string;
  tempC: string;
  feelsLikeC: string | null;
  humidity: string | null;
  windKmph: string | null;
  highC: string | null;
  lowC: string | null;
}

/** Current conditions from wttr.in. Throws with a message fit to show when there are none. */
export async function fetchWeather(
  city: string,
  ctx: Pick<ToolContext, "fetch">,
): Promise<Weather> {
  let data: WttrResponse;
  try {
    const response = await ctx.fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new HttpError(response.status);
    data = (await response.json()) as WttrResponse;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new Error(
      `Weather service unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const current = data.current_condition?.[0];
  if (!current?.temp_C) throw new Error(`No weather data for "${city}".`);
  const area = data.nearest_area?.[0];
  const today = data.weather?.[0];
  return {
    area: area?.areaName?.[0]?.value || city,
    country: area?.country?.[0]?.value || null,
    condition: current.weatherDesc?.[0]?.value?.trim() || "unknown conditions",
    tempC: current.temp_C,
    feelsLikeC: current.FeelsLikeC ?? null,
    humidity: current.humidity ?? null,
    windKmph: current.windspeedKmph ?? null,
    highC: today?.maxtempC ?? null,
    lowC: today?.mintempC ?? null,
  };
}

class HttpError extends Error {
  constructor(status: number) {
    super(`Weather service returned HTTP ${status}.`);
  }
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

    let weather: Weather;
    try {
      weather = await fetchWeather(city, ctx);
    } catch (error) {
      return fail("failed", error instanceof Error ? error.message : String(error));
    }

    const place = [weather.area, weather.country].filter(Boolean).join(", ");
    return ok(
      `${place}: ${weather.condition}, ${weather.tempC}°C (feels like ${weather.feelsLikeC ?? "?"}°C), ` +
        `humidity ${weather.humidity ?? "?"}%, wind ${weather.windKmph ?? "?"} km/h.`,
    );
  },
};
