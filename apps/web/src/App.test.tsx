/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ForecastResponseSchema,
  type ApiSpot,
  type ForecastResponse,
  type SpotsResponse
} from "@surf/contracts";
import { getSpotProfile } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { App } from "./App";

const referenceSpot = getSpotProfile("bolinas");

const spot = {
  ...referenceSpot,
  id: "test-break",
  name: "Test Break",
  sourceMap: {
    nwsWaveGrid: {
      provider: "NOAA/NWS MTR",
      forecastGridData: "https://api.weather.gov/gridpoints/MTR/85,105",
      breakingHeightScale: 1,
      notes: "DOM-test source summary."
    },
    observedWave: [
      { provider: "NDBC", stationId: "46237", name: "San Francisco Bar" }
    ],
    coopsTide: { stationId: "9414958", name: "Bolinas Lagoon" }
  }
} satisfies ApiSpot;

const spotsResponse = {
  spots: [spot],
  sourceNote: "DOM-test catalog."
} satisfies SpotsResponse;

function fixtureForecast(forecastSpot: ApiSpot = spot): ForecastResponse {
  const fixture = buildFixtureForecast("bolinas");
  return ForecastResponseSchema.parse({
    ...fixture,
    spot: forecastSpot,
    windows: fixture.windows.map((window) => ({ ...window, spotId: forecastSpot.id }))
  });
}

function unavailableForecast(forecast = fixtureForecast()): ForecastResponse {
  return ForecastResponseSchema.parse({
    ...forecast,
    windows: forecast.windows.map((window) => ({
      ...window,
      ratingStatus: "unknown"
    }))
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function requestPath(input: URL | RequestInfo): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.pathname : input.url;
}

function installSuccessfulApi() {
  const forecast = fixtureForecast();
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const path = requestPath(input);
    if (path === "/api/spots") return jsonResponse(spotsResponse);
    if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
    if (path === `/api/forecast/${spot.id}?interval=1h`) return jsonResponse({ ...forecast, interval: "1h" });
    if (path === `/api/forecast/${spot.id}?interval=3h`) return jsonResponse({ ...forecast, interval: "3h" });
    if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("App", () => {
  it("renders the daily dashboard from the runtime API catalog", async () => {
    window.history.replaceState({}, "", "/");
    const fetchMock = installSuccessfulApi();

    render(<App />);

    expect(await screen.findByText("NorCal daily surf report")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Compare spots" })).toBeTruthy();
    expect(screen.getAllByText("Test Break").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual([
      "/api/spots",
      "/api/forecast/test-break"
    ]);
  });

  it("uses nontechnical delayed-update copy when a forecast is unavailable on first load", async () => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) {
        return jsonResponse({ error: "forecast_temporarily_unavailable" }, 503);
      }
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    expect(await screen.findByText("Forecast update delayed. Open for available details.")).toBeTruthy();
    expect(screen.queryByText(/forecast service error/i)).toBeNull();
    expect(screen.queryByText(/forecast_temporarily_unavailable/i)).toBeNull();
  });

  it("retries an initially unavailable forecast after five minutes", async () => {
    const intervals: Array<{ callback: () => void; delay: number | undefined }> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (typeof handler === "function") intervals.push({ callback: handler, delay });
      return globalThis.setTimeout(() => undefined, 0);
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const forecast = fixtureForecast();
    let forecastRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) {
        forecastRequests += 1;
        return forecastRequests === 1
          ? jsonResponse({ error: "forecast_temporarily_unavailable" }, 503)
          : jsonResponse(forecast);
      }
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    expect(await screen.findByText("Forecast update delayed. Open for available details.")).toBeTruthy();
    await waitFor(() => {
      expect(intervals.some(({ delay }) => delay === 5 * 60 * 1000)).toBe(true);
    });
    const delayedRetry = [...intervals].reverse().find(({ delay }) => delay === 5 * 60 * 1000);
    expect(delayedRetry).toBeTruthy();
    const normalIntervalCount = intervals.filter(({ delay }) => delay === 15 * 60 * 1000).length;

    await act(async () => delayedRetry!.callback());

    await waitFor(() => expect(forecastRequests).toBe(2));
    expect(screen.queryByText("Forecast update delayed. Open for available details.")).toBeNull();
    expect(screen.queryByText("Some forecasts are temporarily unavailable. We'll try again automatically.")).toBeNull();
    await waitFor(() => {
      expect(intervals.filter(({ delay }) => delay === 15 * 60 * 1000).length).toBeGreaterThan(normalIntervalCount);
    });
  });

  it("keeps a healthy spot usable when another spot is unavailable", async () => {
    const healthySpot = { ...spot, id: "healthy-break", name: "Healthy Break" } satisfies ApiSpot;
    const delayedSpot = { ...spot, id: "delayed-break", name: "Delayed Break" } satisfies ApiSpot;
    const catalog = {
      spots: [healthySpot, delayedSpot],
      sourceNote: "DOM-test mixed availability catalog."
    } satisfies SpotsResponse;
    const healthyForecast = fixtureForecast(healthySpot);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(catalog);
      if (path === `/api/forecast/${healthySpot.id}`) return jsonResponse(healthyForecast);
      if (path === `/api/forecast/${delayedSpot.id}`) {
        return jsonResponse({ error: "forecast_temporarily_unavailable" }, 503);
      }
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    expect(await screen.findByText(/The calmest surface forecast is Healthy Break/)).toBeTruthy();
    expect(screen.queryByText("No reliable regional call yet")).toBeNull();
    expect(screen.getAllByText("Healthy Break").length).toBeGreaterThan(0);
    expect(screen.getByText("Forecast update delayed. Open for available details.")).toBeTruthy();
  });

  it("opens a query-string-selected spot returned by the API", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    installSuccessfulApi();

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Test Break" })).toBeTruthy();
    // Forecast is the default tab: deterministic data first, zero AI content,
    // and no /brief request until Analysis is selected.
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Spot view" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Forecast view" })).toBeTruthy();
    expect(screen.queryByText("Daily outlook")).toBeNull();
    expect(screen.queryByText(/AI-assisted|Gemini|Google/i)).toBeNull();
    expect(screen.queryByText(/deterministic fallback/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Daily report/ }).getAttribute("href")).toBe("/");
    expect(new URLSearchParams(window.location.search).get("tab")).toBeNull();
  });

  it("deep-links to Analysis, fetches the brief only there, and round-trips the tab param", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const fetchMock = installSuccessfulApi();

    render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    const briefCalls = () =>
      fetchMock.mock.calls.filter(([input]) => requestPath(input).includes("/brief?")).length;
    expect(briefCalls()).toBe(0);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Analysis" }), { button: 0, ctrlKey: false });
    // The Worker publishes no brief here (404), so the card is the local
    // forecast read and must be labelled as one rather than as an outlook.
    expect(await screen.findByText("Forecast read")).toBeTruthy();
    expect(screen.queryByText("Daily outlook")).toBeNull();
    expect(screen.getByText("Data, confidence & provenance")).toBeTruthy();
    await waitFor(() => expect(briefCalls()).toBeGreaterThan(0));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("analysis");
    // The forecast table is unmounted while Analysis is active.
    expect(screen.queryByRole("table", { name: /surf-planning inputs/ })).toBeNull();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("tab")).toBeNull();
  });

  it("renders the slim-header freshness badge from the worst cadence-bearing source", async () => {
    const badgeCase = async (
      entries: Array<Record<string, unknown>>,
      activeCapabilities?: string[]
    ): Promise<string | null> => {
      cleanup();
      window.history.replaceState({}, "", "/?spot=test-break");
      const base = fixtureForecast();
      const forecast = ForecastResponseSchema.parse({
        ...base,
        generatedAt: new Date().toISOString(),
        windows: base.windows.map((window) => ({
          ...window,
          sourceFreshness: entries,
          ...(activeCapabilities ? { activeCapabilities } : {})
        }))
      });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
        if (path.includes("/brief?")) return jsonResponse({ error: "not generated" }, 404);
        return jsonResponse({ error: "not found" }, 404);
      }));
      const { container } = render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Test Break" });
      return container.querySelector(".freshnessBadge")?.textContent?.trim() ?? null;
    };

    const entry = (overrides: Record<string, unknown>) => ({
      capability: "wind",
      sourceId: "nws:point-forecast-alerts",
      sourceRunId: "run",
      updatedAt: "2026-08-05T12:00:00.000Z",
      freshnessMinutes: 30,
      status: "fresh",
      expectedCadenceMinutes: 360,
      graceMinutes: 180,
      ...overrides
    });

    // All fresh → fresh; one aging → aging; one late → late (worst wins).
    expect(await badgeCase([entry({}), entry({ capability: "tide", sourceId: "coops:tide-predictions" })])).toBe("Data fresh");
    expect(await badgeCase([entry({}), entry({ capability: "tide", sourceId: "coops:tide-predictions", freshnessMinutes: 500 })])).toBe("Data aging");
    expect(await badgeCase([entry({ freshnessMinutes: 900 }), entry({ capability: "tide", sourceId: "coops:tide-predictions" })])).toBe("Data late");

    // A whole-source absence is "missing", not late: the badge must agree with
    // the banner's exclusion and the provenance panel's "Missing" label.
    expect(
      await badgeCase([entry({}), entry({ capability: "observed_wave", sourceId: "ndbc:preferred", updatedAt: null, freshnessMinutes: null, status: "missing" })])
    ).toBe("Data fresh");

    // No cadence anywhere → no badge rather than a re-judged guess.
    expect(
      await badgeCase([entry({ expectedCadenceMinutes: undefined, graceMinutes: undefined })])
    ).toBeNull();

    // A late buoy leaves the worker's activeCapabilities set at exactly the age
    // its verdict turns late. The badge must still report it, because the
    // banner names that source and the provenance panel labels it Stale —
    // silently upgrading it to "Data fresh" would be the contradiction.
    expect(
      await badgeCase(
        [
          entry({}),
          entry({
            capability: "observed_wave",
            sourceId: "ndbc-46237",
            freshnessMinutes: 180,
            status: "stale",
            expectedCadenceMinutes: 60,
            graceMinutes: 60
          })
        ],
        ["forecast_wave_nearshore", "wind", "tide"]
      )
    ).toBe("Data late");
  });

  it("renders exactly one home link per catalog spot with no shortlist or source-count claim", async () => {
    installSuccessfulApi();

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    const spotLinks = screen
      .getAllByRole("link")
      .filter((link) => (link.getAttribute("href") ?? "").includes("spot="));
    expect(spotLinks).toHaveLength(1); // one catalog spot in the fixture
    expect(screen.queryByLabelText("Quick spot shortlist")).toBeNull();
    expect(screen.queryByText(/coastal source update/)).toBeNull();
  });

  it("keeps the last good forecast visible when a background refresh fails", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    let forecastRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) {
        forecastRequests += 1;
        return forecastRequests === 1
          ? jsonResponse(forecast)
          : jsonResponse({ error: "temporarily unavailable" }, 503);
      }
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 503);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".spotCall")?.textContent).toContain("modeled nearshore Hs");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(/Test Break is refreshing — showing data from/)
    ).toBeTruthy();
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".spotCall")?.textContent).toContain("modeled nearshore Hs");
    expect(container.querySelector(".spotCall")?.textContent).not.toContain("No reliable wave call yet");
  });

  it("keeps the last good forecast visible when a successful response has no usable windows", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    let forecastRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) {
        forecastRequests += 1;
        return jsonResponse(forecastRequests === 1 ? forecast : unavailableForecast(forecast));
      }
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(/Test Break is refreshing — showing data from/)
    ).toBeTruthy();
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".spotCall")?.textContent).toContain("modeled nearshore Hs");
    expect(container.querySelector(".spotCall")?.textContent).not.toContain("No reliable wave call yet");
  });

  it("banners a late source by name and cadence, from the payload's own verdict inputs", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const lateForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [{
              capability: "observed_wave",
              sourceId: "ndbc-46237",
              sourceRunId: "obs-run",
              updatedAt: new Date(Date.now() - 186 * 60_000).toISOString(),
              freshnessMinutes: 186,
              status: "stale",
              expectedCadenceMinutes: 60,
              graceMinutes: 60
            }]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(lateForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    expect(await screen.findByText("Buoy observations 3.1h old; expected hourly.")).toBeTruthy();
  });

  it("shows no banner when sources are merely aging within their declared grace", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const agingForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [{
              capability: "observed_wave",
              sourceId: "ndbc-46237",
              sourceRunId: "obs-run",
              updatedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
              freshnessMinutes: 90,
              status: "fresh",
              expectedCadenceMinutes: 60,
              graceMinutes: 60
            }]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(agingForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });

  it("collapses the header chip range when distinct ages format to the same label", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const spreadForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshnessMinutes: index === 0 ? 181 : 200
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(spreadForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    // 181m and 200m both format to "3h": one collapsed value, never "3h–3h".
    expect(await screen.findByText("Source data 3h old")).toBeTruthy();
  });

  it("renders a genuine chip range when ages format differently", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const spreadForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshnessMinutes: index === 0 ? 45 : 300
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(spreadForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    expect(await screen.findByText("Sources 45m–5h old")).toBeTruthy();
  });

  it("keeps the delayed banner's last-good time anchored across failing refresh cycles", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-05T15:00:00") });
    try {
      window.history.replaceState({}, "", "/?spot=test-break");
      const forecast = fixtureForecast();
      let failRefreshes = false;
      let forecastRequests = 0;
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) {
          forecastRequests += 1;
          return failRefreshes
            ? jsonResponse({ error: "forecast_temporarily_unavailable" }, 503)
            : jsonResponse(forecast);
        }
        if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
        return jsonResponse({ error: "not found" }, 404);
      }));

      render(<App />);
      expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();

      failRefreshes = true;
      vi.setSystemTime(new Date("2026-08-05T15:20:00"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      const banner = await screen.findByText(/Test Break is refreshing — showing data from/);
      const anchoredText = banner.textContent;
      expect(anchoredText).toContain("3:00");

      vi.setSystemTime(new Date("2026-08-05T15:40:00"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(forecastRequests).toBe(3));

      // The time must stay anchored at the retained forecast's real fetch
      // time — never drift toward the latest failing refresh pass.
      const persistent = await screen.findByText(/Test Break is refreshing — showing data from/);
      expect(persistent.textContent).toBe(anchoredText);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names multiple delayed spots with a counted subject", async () => {
    const spotB = { ...spot, id: "second-break", name: "Second Break" } satisfies ApiSpot;
    const twoSpots = { spots: [spot, spotB], sourceNote: "DOM-test catalog." } satisfies SpotsResponse;
    const forecast = fixtureForecast();
    const forecastB = fixtureForecast(spotB);
    let failRefreshes = false;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(twoSpots);
      if (path === `/api/forecast/${spot.id}`) {
        return failRefreshes ? jsonResponse({ error: "unavailable" }, 503) : jsonResponse(forecast);
      }
      if (path === `/api/forecast/${spotB.id}`) {
        return failRefreshes ? jsonResponse({ error: "unavailable" }, 503) : jsonResponse(forecastB);
      }
      if (path.includes("/brief?")) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);
    expect((await screen.findAllByRole("link", { name: /Second Break/ })).length).toBeGreaterThan(0);

    failRefreshes = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(/Test Break \+ 1 other are refreshing — showing data from/)
    ).toBeTruthy();
  });

  it("banners the worst late source and renders non-hourly cadence labels", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const lateForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [
              {
                capability: "wind",
                sourceId: "nws:point-forecast-alerts",
                sourceRunId: "wind-run",
                updatedAt: new Date(Date.now() - 900 * 60_000).toISOString(),
                freshnessMinutes: 900,
                status: "stale",
                expectedCadenceMinutes: 360,
                graceMinutes: 180
              },
              {
                capability: "observed_wave",
                sourceId: "ndbc-46237",
                sourceRunId: "obs-run",
                updatedAt: new Date(Date.now() - 186 * 60_000).toISOString(),
                freshnessMinutes: 186,
                status: "stale",
                expectedCadenceMinutes: 60,
                graceMinutes: 60
              }
            ]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(lateForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    // Wind at 900/540 (ratio 1.67) beats the buoy at 186/120 (ratio 1.55).
    expect(await screen.findByText("Wind forecast 15h old; expected every 6 hours.")).toBeTruthy();
  });

  it("scopes the late banner to the affected spot when other spots' sources are fresh", async () => {
    const spotB = { ...spot, id: "second-break", name: "Second Break" } satisfies ApiSpot;
    const twoSpots = { spots: [spot, spotB], sourceNote: "DOM-test catalog." } satisfies SpotsResponse;
    const entry = (freshnessMinutes: number, status: "fresh" | "stale") => ({
      capability: "observed_wave" as const,
      sourceId: "ndbc-46237",
      sourceRunId: "obs-run",
      updatedAt: new Date(Date.now() - freshnessMinutes * 60_000).toISOString(),
      freshnessMinutes,
      status,
      expectedCadenceMinutes: 60,
      graceMinutes: 60
    });
    const withEntry = (forecast: ForecastResponse, freshnessMinutes: number, status: "fresh" | "stale") =>
      ForecastResponseSchema.parse({
        ...forecast,
        generatedAt: new Date().toISOString(),
        windows: forecast.windows.map((window, index) => ({
          ...window,
          sourceFreshness: index === 0 ? [entry(freshnessMinutes, status)] : window.sourceFreshness
        }))
      });
    const lateForecast = withEntry(fixtureForecast(), 186, "stale");
    const freshForecast = withEntry(fixtureForecast(spotB), 20, "fresh");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(twoSpots);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(lateForecast);
      if (path === `/api/forecast/${spotB.id}`) return jsonResponse(freshForecast);
      if (path.includes("/brief?")) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    // The buoy is late for Test Break only, so the banner names the spot
    // instead of contradicting Second Break's fresh source panel.
    expect(
      await screen.findByText("Buoy observations at Test Break 3.1h old; expected hourly.")
    ).toBeTruthy();
  });

  it("never banners null-age placeholders or pre-cadence entries", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    const quietForecast = ForecastResponseSchema.parse({
      ...forecast,
      generatedAt: new Date().toISOString(),
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === 0
          ? [
              {
                // Placeholder: a source that never produced data.
                capability: "observed_wave",
                sourceId: "ndbc:preferred",
                sourceRunId: null,
                updatedAt: null,
                freshnessMinutes: null,
                status: "missing",
                expectedCadenceMinutes: 60,
                graceMinutes: 60
              },
              {
                // Pre-cadence legacy entry: ancient but ships no expectations.
                capability: "wind",
                sourceId: "nws:point-forecast-alerts",
                sourceRunId: "wind-run",
                updatedAt: "2026-08-01T00:00:00.000Z",
                freshnessMinutes: 5000,
                status: "stale"
              }
            ]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(quietForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });

  it("keeps the table, graph, interval, and selected timestamp in the URL", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const fetchMock = installSuccessfulApi();

    render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    const graphTab = screen.getByRole("tab", { name: "Graph" });
    fireEvent.mouseDown(graphTab, { button: 0, ctrlKey: false });
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("view")).toBe("graph");
    });
    expect(await screen.findByRole("img", { name: "Stepped modeled nearshore wave-height chart" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "One-hour resolution" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => requestPath(input) === `/api/forecast/${spot.id}?interval=1h`)).toBe(true);
    });
    expect(new URLSearchParams(window.location.search).get("interval")).toBe("1h");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Table" }), { button: 0, ctrlKey: false });
    await screen.findByRole("table", { name: /One-hour surf-planning inputs/ });
    const secondTimeButton = screen.getAllByRole("rowheader")[1]?.querySelector("button");
    expect(secondTimeButton).toBeTruthy();
    fireEvent.click(secondTimeButton!);
    expect(new URLSearchParams(window.location.search).get("at")).toBeTruthy();
    expect(screen.getAllByLabelText(/^Why .* looks this way$/).length).toBeGreaterThan(0);
  });

  it("shares a recovered canonical workbench forecast with the hero after an unusable initial response", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(unavailableForecast(forecast));
      if (path === `/api/forecast/${spot.id}?interval=3h`) {
        await recoveryGate;
        return jsonResponse({ ...forecast, interval: "3h" });
      }
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Test Break" })).toBeTruthy();
    expect(container.querySelector(".spotCall")?.textContent).toContain("No reliable wave call yet");
    expect(screen.getByText("Some forecasts are temporarily unavailable. We'll try again automatically.")).toBeTruthy();

    releaseRecovery();
    await waitFor(() => {
      expect(container.querySelector(".spotCall")?.textContent).toContain("modeled nearshore Hs");
      expect(container.querySelector(".spotCall")?.textContent).not.toContain("No reliable wave call yet");
      expect(screen.queryByText("Some forecasts are temporarily unavailable. We'll try again automatically.")).toBeNull();
    });
  });

  it("does not clear a catalog-refresh warning when a forecast retry recovers", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const refreshIntervals: Array<number | undefined> = [];
    vi.spyOn(window, "setInterval").mockImplementation((_handler, delay) => {
      refreshIntervals.push(delay);
      return globalThis.setTimeout(() => undefined, 0);
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const forecast = fixtureForecast();
    let spotRequests = 0;
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") {
        spotRequests += 1;
        return spotRequests === 1
          ? jsonResponse(spotsResponse)
          : jsonResponse({ error: "catalog unavailable" }, 503);
      }
      if (path === `/api/forecast/${spot.id}`) return jsonResponse({ error: "temporarily unavailable" }, 503);
      if (path === `/api/forecast/${spot.id}?interval=3h`) {
        await recoveryGate;
        return jsonResponse({ ...forecast, interval: "3h" });
      }
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);
    expect(await screen.findByText("Some forecasts are temporarily unavailable. We'll try again automatically.")).toBeTruthy();
    await waitFor(() => {
      expect(refreshIntervals).toContain(5 * 60 * 1000);
    });
    const normalIntervalCount = refreshIntervals.filter(
      (delay) => delay === 15 * 60 * 1000
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("The latest update is delayed. Showing the last forecast we loaded.")).toBeTruthy();
    expect(
      refreshIntervals.filter((delay) => delay === 15 * 60 * 1000)
    ).toHaveLength(normalIntervalCount);

    releaseRecovery();
    await waitFor(() => {
      expect(container.querySelector(".spotCall")?.textContent).toContain("modeled nearshore Hs");
    });
    expect(screen.getByText("The latest update is delayed. Showing the last forecast we loaded.")).toBeTruthy();
  });

  it("shows a visible error when the spot catalog API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "unavailable" }, 503))
    );

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Surf data is temporarily unavailable. Please try again.");
    expect(alert.textContent).not.toContain("/api/spots");
    expect(alert.textContent).not.toContain("503");
  });
});
