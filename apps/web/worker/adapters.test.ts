import { NORCAL_SPOTS } from "@surf/forecast-core";
import { describe, expect, it } from "vitest";
import {
  buildCoopsTideEventsUrl,
  buildCoopsTidePredictionsUrl,
  fetchCoopsTidePredictionsForSpots
} from "./adapters/coops";
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
    expect(buildCoopsTideEventsUrl("9414290", now, new Date("2026-07-09T12:00:00Z")))
      .toContain("interval=hilo");
  });

  it("fetches tide prediction rows for mapped v1 spots", async () => {
    const fetcher: SourceFetch = async (input) => {
      const url = String(input);
      expect(url).toContain("api.tidesandcurrents.noaa.gov");
      if (url.includes("interval=hilo")) {
        return Response.json({
          predictions: [
            { t: "2026-07-08 12:27", v: "2.1", type: "H" },
            { t: "2026-07-08 18:44", v: "0.2", type: "L" }
          ]
        });
      }
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
    expect(outcome.events).toEqual([
      {
        spotId: "obsf-central",
        stationId: "9414290",
        eventAt: "2026-07-08T12:27:00.000Z",
        tideFtMllw: 2.1,
        eventType: "high"
      },
      {
        spotId: "obsf-central",
        stationId: "9414290",
        eventAt: "2026-07-08T18:44:00.000Z",
        tideFtMllw: 0.2,
        eventType: "low"
      }
    ]);
  });

  it.each(["network", "invalid-json", "http"] as const)(
    "retains hourly tides when the additive high/low request has a %s failure",
    async (failureMode) => {
      const fetcher: SourceFetch = async (input) => {
        const url = String(input);
        if (!url.includes("interval=hilo")) {
          return Response.json({
            predictions: [
              { t: "2026-07-08 12:00", v: "1.2" },
              { t: "2026-07-08 13:00", v: "1.8" }
            ]
          });
        }
        if (failureMode === "network") throw new Error("event endpoint unavailable");
        if (failureMode === "invalid-json") {
          return new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
      };

      const outcome = await fetchCoopsTidePredictionsForSpots([NORCAL_SPOTS[1]!], {
        fetcher,
        now,
        horizonHours: 24
      });

      expect(outcome.status).toBe("partial");
      expect(outcome.rows).toHaveLength(2);
      expect(outcome.events).toEqual([]);
      expect(outcome.errors).toEqual([]);
      expect(outcome.caveats.some((caveat) => caveat.code === "coops_tide_events_unavailable"))
        .toBe(true);
    }
  );

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
                expires: "2026-07-08T21:00:00-07:00",
                ends: "2026-07-10T21:00:00-07:00"
              }
            },
            {
              properties: {
                event: "Small Craft Advisory",
                headline: "Short-lived product without an event end",
                effective: "2026-07-08T10:00:00-07:00",
                expires: "2026-07-08T22:00:00-07:00"
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
    expect(outcome.metadata.hazardCount).toBe(2);
    expect(outcome.rows[0]?.windForecasts[0]).toMatchObject({
      spotId: "obsf-central",
      issuedAt: "2026-07-08T18:30:00.000Z",
      windSpeedKt: 6.5,
      windDirectionDeg: 315,
      gustKt: 13
    });
    expect(outcome.rows[0]?.hazards[0]).toMatchObject({
      event: "Beach Hazards Statement",
      effectiveAt: "2026-07-08T16:00:00.000Z",
      // The event end wins over the earlier CAP product expiration.
      expiresAt: "2026-07-11T04:00:00.000Z"
    });
    expect(outcome.rows[0]?.hazards[1]).toMatchObject({
      event: "Small Craft Advisory",
      // CAP products that omit `ends` retain the legacy `expires` fallback.
      expiresAt: "2026-07-09T05:00:00.000Z"
    });
    expect(outcome.rows[0]?.alertsFetchSucceeded).toBe(true);
    expect(outcome.metadata.alertsFetchSucceededSpotIds).toEqual(["obsf-central"]);
  });

  it.each(["http", "malformed"] as const)(
    "keeps wind context but marks alerts unsuccessful when the alerts request is %s",
    async (failureMode) => {
    const forecastUrl = "https://api.weather.gov/gridpoints/MTR/85,105/forecast/hourly";
    const fetcher: SourceFetch = async (input) => {
      const url = String(input);
      if (url.includes("/points/")) {
        return Response.json({ properties: { forecastHourly: forecastUrl } });
      }
      if (url === forecastUrl) {
        return Response.json({
          properties: {
            updated: "2026-07-08T18:30:00Z",
            periods: [{
              startTime: "2026-07-08T12:00:00-07:00",
              endTime: "2026-07-08T13:00:00-07:00",
              windSpeed: "5 mph",
              windDirection: "NW",
              shortForecast: "Mostly Sunny"
            }]
          }
        });
      }
      if (url.includes("/alerts/active")) {
        return failureMode === "http"
          ? new Response("unavailable", { status: 503 })
          : Response.json({});
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const outcome = await fetchNwsContextForSpots([NORCAL_SPOTS[1]!], { fetcher });

    expect(outcome.status).toBe("success");
    expect(outcome.rows[0]?.windForecasts).toHaveLength(1);
    expect(outcome.rows[0]?.hazards).toEqual([]);
    expect(outcome.rows[0]?.alertsFetchSucceeded).toBe(false);
    expect(outcome.metadata.alertsFetchSucceededSpotIds).toEqual([]);
    expect(outcome.caveats).toContainEqual(
      expect.objectContaining({ code: "nws_alerts_unavailable" })
    );
    }
  );
});
