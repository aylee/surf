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
    expect(screen.getByRole("heading", { name: "Forecast workbench" })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.getByText("Daily outlook")).toBeTruthy();
    expect(screen.queryByText(/AI-assisted|Gemini|Google/i)).toBeNull();
    expect(screen.queryByText(/deterministic fallback/i)).toBeNull();
    expect(screen.getByRole("link", { name: /Daily report/ }).getAttribute("href")).toBe("/");
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

  it("keeps the table, graph, interval, and selected timestamp in the URL", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const fetchMock = installSuccessfulApi();

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Forecast workbench" })).toBeTruthy();
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
