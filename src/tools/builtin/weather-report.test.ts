import { describe, expect, it, vi } from "vitest";
import { testContext } from "../testing/context";
import { fetchWeather, weatherReport } from "./weather-report";

const sample = {
  current_condition: [
    {
      temp_C: "19",
      FeelsLikeC: "18",
      humidity: "77",
      windspeedKmph: "13",
      weatherDesc: [{ value: "Partly cloudy " }],
    },
  ],
  nearest_area: [{ areaName: [{ value: "Lima" }], country: [{ value: "Peru" }] }],
};

const respond = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("weather_report", () => {
  it("summarizes the current conditions", async () => {
    const fetch = respond(sample);
    const result = await weatherReport.execute({ city: "Lima" }, testContext({ fetch }));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://wttr.in/Lima?format=j1");
    expect(result).toEqual({
      ok: true,
      output: "Lima, Peru: Partly cloudy, 19°C (feels like 18°C), humidity 77%, wind 13 km/h.",
    });
  });

  it("encodes the city name", async () => {
    const fetch = respond(sample);
    await weatherReport.execute({ city: "São Paulo, Brazil" }, testContext({ fetch }));
    expect(fetch.mock.calls[0]?.[0]).toBe("https://wttr.in/S%C3%A3o%20Paulo%2C%20Brazil?format=j1");
  });

  it("fails on HTTP errors", async () => {
    const result = await weatherReport.execute(
      { city: "Lima" },
      testContext({ fetch: respond({}, 503) }),
    );
    expect(result).toEqual({
      ok: false,
      code: "failed",
      error: "Weather service returned HTTP 503.",
    });
  });

  it("fails when the service is unreachable", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const result = await weatherReport.execute({ city: "Lima" }, testContext({ fetch }));
    expect(result).toMatchObject({ ok: false, code: "failed" });
  });

  it("fails when there is no data", async () => {
    const result = await weatherReport.execute(
      { city: "Atlantis" },
      testContext({ fetch: respond({}) }),
    );
    expect(result).toEqual({ ok: false, code: "failed", error: 'No weather data for "Atlantis".' });
  });

  it("reads today's high and low for the widget", async () => {
    const fetch = respond({ ...sample, weather: [{ maxtempC: "24", mintempC: "18" }] });
    await expect(fetchWeather("Lima", testContext({ fetch }))).resolves.toMatchObject({
      area: "Lima",
      tempC: "19",
      highC: "24",
      lowC: "18",
    });
  });

  it("leaves the high and low empty without a forecast", async () => {
    await expect(
      fetchWeather("Lima", testContext({ fetch: respond(sample) })),
    ).resolves.toMatchObject({ highC: null, lowC: null });
  });
});
