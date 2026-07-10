import { NORCAL_SPOTS } from "@surf/forecast-core";
import { describe, expect, it } from "vitest";
import { buildCoopsTidePredictionsUrl, fetchCoopsTidePredictionsForSpots } from "./adapters/coops";
import { buildNwsAlertsUrl, buildNwsPointUrl, fetchNwsContextForSpots } from "./adapters/nws";
import type { SourceFetch } from "./adapters/types";

const now = new Date("2026-07-08T12:00:00Z");

describe("CO-OPS tide adapter", () => {
  it("builds a tide predictions URL for hourly MLLW JSON", () => {
    const url = buildCoopsTidePredictionsUrl("9414290", now, new Date("2026-07-09T12:00:00Z"));
    expect(url).toContain("station=9414290");
    expect(url).toContain("product=predictions");
    expect(url).toContain("datum=MLLW");
    expect(url).toContain("interval=h");
    expect(url).toContain("format=json");
  });

  it("fetches tide prediction rows for mapped v1 spots", async () => {
    const fetcher: SourceFetch = async (input) => {
      const url = String(input);
      expect(url).toContain("api.tidesandcurrents.noaa.gov");
      return Response.json({
        predictions: [
          { t: "2026-07-08 12:00", v: "1.2" },
          { t: "2026-07-08 13:00", v: "1.8" },
          { t: "2026-07-08 14:00", v: "1.7" }
        ]
      });
    };

    const outcome = await fetchCoopsTidePredictionsForSpots([NORCAL_SPOTS[1]!], {
      fetcher,
      now,
      horizonHours: 24
    });

    expect(outcome.status).toBe("success");
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows[0]).toMatchObject({
      spotId: "obsf-central",
      stationId: "9414290",
      forecastAt: "2026-07-08T12:00:00.000Z",
      tideFtMllw: 1.2,
      tideTrend: "rising"
    });
  });

  it("reports CO-OPS API failures without fabricating rows", async () => {
    const fetcher: SourceFetch = async () =>
      Response.json({
        error: { message: "No data was found." }
      });

    const outcome = await fetchCoopsTidePredictionsForSpots([NORCAL_SPOTS[1]!], {
      fetcher,
      now,
      horizonHours: 24
    });

    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toHaveLength(0);
    expect(outcome.errors[0]).toContain("No data was found");
  });
});

describe("NWS adapter", () => {
  it("builds point and alerts URLs from a spot coordinate", () => {
    expect(buildNwsPointUrl(37.759, -122.51)).toBe("https://api.weather.gov/points/37.7590,-122.5100");
    expect(buildNwsAlertsUrl(37.759, -122.51)).toBe(
      "https://api.weather.gov/alerts/active?point=37.7590%2C-122.5100"
    );
  });

  it("fetches point, wind forecast, and hazard context with injected fixtures", async () => {
    const forecastUrl = "https://api.weather.gov/gridpoints/MTR/85,105/forecast/hourly";
    const fetcher: SourceFetch = async (input) => {
      const url = String(input);
      if (url.includes("/points/")) {
        return Response.json({
          properties: {
            forecastHourly: forecastUrl,
            forecastZone: "https://api.weather.gov/zones/forecast/CAZ006",
            gridId: "MTR",
            gridX: 85,
            gridY: 105
          }
        });
      }
      if (url === forecastUrl) {
        return Response.json({
          properties: {
            updated: "2026-07-08T18:30:00Z",
            periods: [
              {
                startTime: "2026-07-08T12:00:00-07:00",
                endTime: "2026-07-08T13:00:00-07:00",
                windSpeed: "5 to 10 mph",
                windGust: "15 mph",
                windDirection: "NW",
                shortForecast: "Mostly Sunny"
              }
            ]
          }
        });
      }
      if (url.includes("/alerts/active")) {
        return Response.json({
          features: [
            {
              properties: {
                event: "Beach Hazards Statement",
                severity: "Moderate",
                urgency: "Expected",
                certainty: "Likely",
                headline: "Sneaker waves possible",
                effective: "2026-07-08T09:00:00-07:00",
                expires: "2026-07-08T21:00:00-07:00"
              }
            }
          ]
        });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const outcome = await fetchNwsContextForSpots([NORCAL_SPOTS[1]!], { fetcher });

    expect(outcome.status).toBe("success");
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.metadata.windRowCount).toBe(1);
    expect(outcome.metadata.hazardCount).toBe(1);
    expect(outcome.rows[0]?.windForecasts[0]).toMatchObject({
      spotId: "obsf-central",
      issuedAt: "2026-07-08T18:30:00.000Z",
      windSpeedKt: 6.5,
      windDirectionDeg: 315,
      gustKt: 13
    });
    expect(outcome.rows[0]?.hazards[0]?.event).toBe("Beach Hazards Statement");
  });
});
