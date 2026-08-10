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
import { hazardNoticesForDate } from "./App";
import { localDayDomain } from "./features/workbench/workbench-time";
import { earliestAvailableLocalDateKey, formatDay, localDateParts } from "./forecast-view";

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

function fixtureForecast(forecastSpot: ApiSpot = spot, now = new Date()): ForecastResponse {
  const fixture = buildFixtureForecast("bolinas", now);
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

function forecastWithDateScopedHazards(now: Date): ForecastResponse {
  const forecast = fixtureForecast(spot, now);
  const reportDate = earliestAvailableLocalDateKey(
    [{ spot, windows: forecast.windows, sunPhases: forecast.sunPhases }],
    now
  );
  if (!reportDate) throw new Error("Fixture has no report date");
  const laterDate = [...new Set(
    forecast.windows.map((window) => localDateParts(window.forecastAt, spot.timezone).key)
  )].find((date) => date > reportDate);
  if (!laterDate) throw new Error("Fixture has no later hazard date");

  const hazardForDate = (localDate: string, headline: string) => {
    const dayEnd = localDayDomain(localDate, spot.timezone).end;
    return {
      headline,
      startsAt: new Date(dayEnd - 60 * 60_000).toISOString(),
      endsAt: new Date(dayEnd).toISOString(),
      sourceId: "nws:point-forecast-alerts",
      sourceRunId: "hazard-run"
    };
  };

  return ForecastResponseSchema.parse({
    ...forecast,
    hazards: [
      hazardForDate(reportDate, "Report-day advisory"),
      hazardForDate(laterDate, "Later-day advisory")
    ]
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

function firstUpcomingWindowIndex(forecast: ForecastResponse, now = new Date()): number {
  const index = forecast.windows.findIndex(
    (window) => Date.parse(window.forecastAt) >= now.getTime()
  );
  return index >= 0 ? index : Math.max(0, forecast.windows.length - 1);
}

function forecastWithSourceAge(forecastSpot: ApiSpot, ageMinutes: number): ForecastResponse {
  const forecast = fixtureForecast(forecastSpot);
  return ForecastResponseSchema.parse({
    ...forecast,
    windows: forecast.windows.map((window) => ({
      ...window,
      sourceFreshnessMinutes: ageMinutes
    }))
  });
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

  it("does not promote an all-wind-unavailable forecast as the best overall window", async () => {
    const base = fixtureForecast();
    const forecast = ForecastResponseSchema.parse({
      ...base,
      windows: base.windows.map((window) => ({
        ...window,
        windDirectionDeg: null
      })),
      recommendations: []
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    await screen.findByText("NorCal daily surf report");
    expect(screen.getByRole("heading", { name: "No reliable regional call yet" })).toBeTruthy();
    expect(screen.queryByText(/best overall window/i)).toBeNull();
    expect(screen.getAllByText("Test Break").length).toBeGreaterThan(0);
  });

  it("keeps home hazards scoped to the local report date", async () => {
    const now = new Date("2026-08-10T14:00:00.000Z"); // Aug 10, 7 AM PDT
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      const forecast = forecastWithDateScopedHazards(now);
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
        return jsonResponse({ error: "not found" }, 404);
      }));

      render(<App />);

      expect(await screen.findByText("Report-day advisory")).toBeTruthy();
      expect(screen.getByText("Upcoming NWS hazard")).toBeTruthy();
      expect(screen.queryByText("Later-day advisory")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels active typed hazards and hides expired typed hazards on home", async () => {
    const forecast = ForecastResponseSchema.parse({
      ...fixtureForecast(),
      hazards: [
        {
          headline: "Active beach advisory",
          startsAt: null,
          endsAt: null,
          sourceId: "nws:point-forecast-alerts",
          sourceRunId: "active-run"
        },
        {
          headline: "Expired beach advisory",
          startsAt: "2020-01-01T00:00:00.000Z",
          endsAt: "2020-01-01T01:00:00.000Z",
          sourceId: "nws:point-forecast-alerts",
          sourceRunId: "expired-run"
        }
      ]
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    expect(await screen.findByText("Active beach advisory")).toBeTruthy();
    expect(screen.getByText("Active NWS hazard")).toBeTruthy();
    expect(screen.queryByText("Expired beach advisory")).toBeNull();
  });

  it("keeps spot hazards scoped to the spot report date", async () => {
    const now = new Date("2026-08-10T14:00:00.000Z"); // Aug 10, 7 AM PDT
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      window.history.replaceState({}, "", "/?spot=test-break");
      const forecast = forecastWithDateScopedHazards(now);
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
        if (path === `/api/forecast/${spot.id}?interval=1h`) return jsonResponse({ ...forecast, interval: "1h" });
        if (path.includes("/brief?")) return jsonResponse({ error: "not generated" }, 404);
        return jsonResponse({ error: "not found" }, 404);
      }));

      render(<App />);

      expect(await screen.findByText("Report-day advisory")).toBeTruthy();
      expect(screen.getByText("Upcoming NWS hazard")).toBeTruthy();
      expect(screen.queryByText("Later-day advisory")).toBeNull();

      const laterHazard = forecast.hazards?.find(
        (hazard) => hazard.headline === "Later-day advisory"
      );
      expect(laterHazard?.startsAt).toBeTruthy();
      const laterDayLabel = formatDay(laterHazard!.startsAt!, spot.timezone);
      const laterDayButton = screen.getAllByRole("button").find((button) =>
        button.closest(".forecastDayPicker") && button.textContent?.includes(laterDayLabel)
      );
      expect(laterDayButton).toBeTruthy();
      fireEvent.click(laterDayButton!);

      expect(await screen.findByText("Later-day advisory")).toBeTruthy();
      expect(screen.getByText("Upcoming NWS hazard")).toBeTruthy();
      await waitFor(() => expect(screen.queryByText("Report-day advisory")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies active and selected-date future hazards with half-open boundaries", () => {
    const now = new Date("2026-08-02T14:00:00.000Z");
    const hazards = [
      {
        headline: "Active advisory",
        startsAt: "2026-08-02T13:00:00.000Z",
        endsAt: "2026-08-02T15:00:00.000Z",
        sourceId: "nws:point-forecast-alerts",
        sourceRunId: "active-run"
      },
      {
        headline: "Future today",
        startsAt: "2026-08-02T16:00:00.000Z",
        endsAt: "2026-08-02T18:00:00.000Z",
        sourceId: "nws:point-forecast-alerts",
        sourceRunId: "future-run"
      },
      {
        headline: "Expires exactly now",
        startsAt: "2026-08-02T12:00:00.000Z",
        endsAt: "2026-08-02T14:00:00.000Z",
        sourceId: "nws:point-forecast-alerts",
        sourceRunId: "expired-run"
      },
      {
        headline: "Starts next midnight",
        startsAt: "2026-08-03T07:00:00.000Z",
        endsAt: "2026-08-03T09:00:00.000Z",
        sourceId: "nws:point-forecast-alerts",
        sourceRunId: "boundary-run"
      }
    ];

    expect(
      hazardNoticesForDate(hazards, now, "2026-08-02", "America/Los_Angeles")
    ).toEqual([
      { headline: "Active advisory", status: "active" },
      { headline: "Future today", status: "upcoming" }
    ]);
    expect(
      hazardNoticesForDate(hazards, now, "2026-08-03", "America/Los_Angeles")
    ).toEqual([
      { headline: "Starts next midnight", status: "upcoming" }
    ]);
  });

  it("keeps a multi-day CAP advisory on intervening report dates until its event end", () => {
    const advisory = [{
      headline: "Coastal Flood Advisory until August 13 at 2:00 AM PDT",
      startsAt: "2026-08-09T17:28:00.000Z",
      endsAt: "2026-08-13T09:00:00.000Z",
      sourceId: "nws:point-forecast-alerts",
      sourceRunId: "multi-day-advisory"
    }];

    expect(
      hazardNoticesForDate(
        advisory,
        new Date("2026-08-10T04:00:00.000Z"),
        "2026-08-10",
        "America/Los_Angeles"
      )
    ).toEqual([{
      headline: "Coastal Flood Advisory until August 13 at 2:00 AM PDT",
      status: "active"
    }]);
    expect(
      hazardNoticesForDate(
        advisory,
        new Date("2026-08-13T09:00:00.000Z"),
        "2026-08-13",
        "America/Los_Angeles"
      )
    ).toEqual([]);
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

    expect(await screen.findByText(/Healthy Break has the best overall window/)).toBeTruthy();
    expect(screen.queryByText("No reliable regional call yet")).toBeNull();
    expect(screen.getAllByText("Healthy Break").length).toBeGreaterThan(0);
    expect(screen.getByText("Forecast update delayed. Open for available details.")).toBeTruthy();
  });

  it("opens a query-string-selected spot returned by the API", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    installSuccessfulApi();

    const { container } = render(<App />);

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
    const hero = container.querySelector(".spotHero");
    expect(hero?.nextElementSibling?.classList.contains("spotWorkbench")).toBe(true);
  });

  it("keeps an authoritative selected-date no-call out of the spot hero", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = ForecastResponseSchema.parse({
      ...fixtureForecast(),
      recommendations: []
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    await screen.findByRole("heading", { level: 1, name: "Test Break" });
    expect(container.querySelector(".spotCall")?.textContent).toContain(
      "No reliable wave call yet"
    );
    expect(container.querySelector(".spotCall")?.textContent).not.toContain("surf with");
  });

  it("keeps an elapsed workbench day shared with the hero, hazard, and Analysis", async () => {
    const now = new Date("2026-08-03T03:00:00.000Z"); // Aug 2, 8 PM PDT
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      window.history.replaceState({}, "", "/?spot=test-break");
      const elapsedDate = "2026-08-02";
      const forecast = ForecastResponseSchema.parse({
        ...fixtureForecast(spot, new Date("2026-08-02T07:00:00.000Z")),
        hazards: [{
          headline: "Elapsed-day advisory",
          startsAt: "2026-08-03T02:30:00.000Z",
          endsAt: "2026-08-03T03:30:00.000Z",
          sourceId: "nws:point-forecast-alerts",
          sourceRunId: "elapsed-hazard-run"
        }]
      });
      const requestedUrls: string[] = [];
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        requestedUrls.push(path);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecast);
        if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) {
          return jsonResponse({ error: "not generated" }, 404);
        }
        return jsonResponse({ error: "not found" }, 404);
      }));

      const { container } = render(<App />);
      await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ });
      expect(screen.queryByText("Elapsed-day advisory")).toBeNull();

      const elapsedDayButton = screen.getAllByRole("button").find((button) =>
        button.closest(".forecastDayPicker") &&
        button.textContent?.includes(formatDay(forecast.windows[0]!.forecastAt, spot.timezone))
      );
      expect(elapsedDayButton).toBeTruthy();
      fireEvent.click(elapsedDayButton!);

      expect(await screen.findByText("Elapsed-day advisory")).toBeTruthy();
      await waitFor(() => expect(container.querySelector(".spotCall")?.textContent).toContain(
        "No reliable wave call yet"
      ));
      expect(new URLSearchParams(window.location.search).get("date")).toBe(elapsedDate);

      fireEvent.mouseDown(screen.getByRole("tab", { name: "Analysis" }), {
        button: 0,
        ctrlKey: false
      });
      await waitFor(() => expect(requestedUrls).toContain(
        `/api/forecast/${spot.id}/brief?date=${elapsedDate}`
      ));
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces and reveals the active item in an overflowing spot navigation", async () => {
    const laterSpot = { ...spot, id: "later-break", name: "Later Break" } satisfies ApiSpot;
    const catalog = {
      spots: [spot, laterSpot],
      sourceNote: "DOM-test navigation catalog."
    } satisfies SpotsResponse;
    const firstForecast = fixtureForecast();
    const laterForecast = fixtureForecast(laterSpot);
    window.history.replaceState({}, "", "/?spot=later-break");
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(catalog);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(firstForecast);
      if (path === `/api/forecast/${laterSpot.id}`) return jsonResponse(laterForecast);
      return jsonResponse({ error: "not found" }, 404);
    }));

    try {
      render(<App />);

      const activeLink = await screen.findByRole("link", { name: "Later Break" });
      expect(activeLink.getAttribute("aria-current")).toBe("page");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest"
      }));
      expect(screen.getByRole("link", { name: "Test Break" }).hasAttribute("aria-current")).toBe(false);
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
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
    // The Worker publishes no report here (404), so Analysis must state that
    // honestly instead of synthesizing a local pseudo-report.
    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
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

  it("keeps steady-state source freshness out of the spot hero", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    installSuccessfulApi();

    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Test Break" });

    expect(container.querySelector(".freshnessBadge")).toBeNull();
    expect(screen.queryByText(/^Data (fresh|aging|late)$/i)).toBeNull();
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
    expect(container.querySelector(".spotCall")?.textContent).toContain("surf with");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(
      await screen.findByText(/Test Break is refreshing — showing data from/)
    ).toBeTruthy();
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".spotCall")?.textContent).toContain("surf with");
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
    expect(container.querySelector(".spotCall")?.textContent).toContain("surf with");
    expect(container.querySelector(".spotCall")?.textContent).not.toContain("No reliable wave call yet");
  });

  it("does not duplicate late-source age below the header", async () => {
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

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });

  it.each([
    {
      name: "late wave input",
      entry: {
        capability: "forecast_wave_nearshore" as const,
        sourceId: "wave:required",
        sourceRunId: "wave-run",
        updatedAt: new Date(Date.now() - 300 * 60_000).toISOString(),
        freshnessMinutes: 300,
        status: "stale" as const,
        expectedCadenceMinutes: 60,
        graceMinutes: 60
      },
      label: "Wave model delayed",
      detail: /Wave model at Test Break is 5h old; expected hourly/
    },
    {
      name: "missing tide input",
      entry: {
        capability: "tide" as const,
        sourceId: "tide:required",
        sourceRunId: null,
        updatedAt: null,
        freshnessMinutes: null,
        status: "missing" as const,
        expectedCadenceMinutes: 1_440,
        graceMinutes: 360
      },
      label: "Tide data unavailable",
      detail: /Tide data at Test Break is unavailable/
    }
  ])("uses the single header indicator for a $name", async ({ entry, label, detail }) => {
    const forecast = fixtureForecast(spot, new Date(Date.now() + 60_000));
    const referenceIndex = firstUpcomingWindowIndex(forecast);
    const degradedForecast = ForecastResponseSchema.parse({
      ...forecast,
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === referenceIndex ? [entry] : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(degradedForecast);
      return jsonResponse({ error: "not found" }, 404);
    }));

    const { container } = render(<App />);

    const indicator = await screen.findByTestId("source-status");
    expect(indicator.textContent).toContain(label);
    expect(indicator.getAttribute("aria-label")).toMatch(detail);
    expect(indicator.classList.contains("degraded")).toBe(true);
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });

  it("does not globalize a missing historical midnight source over a healthy live row", async () => {
    const now = new Date("2026-08-03T03:00:00.000Z"); // Aug 2, 8 PM PDT
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      const freshWave = {
        capability: "forecast_wave_nearshore" as const,
        sourceId: "nws:mtr-grid-wave",
        sourceRunId: "live-wave-run",
        updatedAt: "2026-08-03T02:15:00.000Z",
        freshnessMinutes: 45,
        status: "fresh" as const,
        expectedCadenceMinutes: 720,
        graceMinutes: 240
      };
      const missingWave = {
        ...freshWave,
        sourceId: "wave:unavailable",
        sourceRunId: null,
        updatedAt: null,
        freshnessMinutes: null,
        status: "missing" as const
      };
      const forecast = fixtureForecast(spot, new Date("2026-08-02T07:00:00.000Z"));
      const fullDayForecast = ForecastResponseSchema.parse({
        ...forecast,
        generatedAt: now.toISOString(),
        windows: forecast.windows.map((window, index) => ({
          ...window,
          sourceFreshnessMinutes: index === 0 ? 30 : 45,
          sourceFreshness: index === 0 ? [missingWave] : [freshWave]
        }))
      });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) return jsonResponse(fullDayForecast);
        return jsonResponse({ error: "not found" }, 404);
      }));

      render(<App />);

      const indicator = await screen.findByTestId("source-status");
      expect(indicator.textContent).toContain("Source data 45m old");
      expect(indicator.classList.contains("degraded")).toBe(false);
      expect(indicator.textContent).not.toContain("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the final retained row for header health when the entire forecast is elapsed", async () => {
    const now = new Date("2026-08-10T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      const forecast = fixtureForecast(spot, new Date("2026-08-02T07:00:00.000Z"));
      const missingTide = {
        capability: "tide" as const,
        sourceId: "tide:unavailable",
        sourceRunId: null,
        updatedAt: null,
        freshnessMinutes: null,
        status: "missing" as const,
        expectedCadenceMinutes: 1_440,
        graceMinutes: 360
      };
      const elapsedForecast = ForecastResponseSchema.parse({
        ...forecast,
        generatedAt: now.toISOString(),
        windows: forecast.windows.map((window, index) => ({
          ...window,
          sourceFreshness: index === forecast.windows.length - 1
            ? [missingTide]
            : window.sourceFreshness
        }))
      });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/spots") return jsonResponse(spotsResponse);
        if (path === `/api/forecast/${spot.id}`) return jsonResponse(elapsedForecast);
        return jsonResponse({ error: "not found" }, 404);
      }));

      render(<App />);

      const indicator = await screen.findByTestId("source-status");
      expect(indicator.textContent).toContain("Tide data unavailable");
      expect(indicator.classList.contains("degraded")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promote an edge-of-horizon missing slot to a global source outage", async () => {
    const forecast = fixtureForecast();
    const forecastWithFutureGap = ForecastResponseSchema.parse({
      ...forecast,
      windows: forecast.windows.map((window, index) => ({
        ...window,
        sourceFreshness: index === forecast.windows.length - 1
          ? [{
              capability: "wind" as const,
              sourceId: "wind:future-gap",
              sourceRunId: null,
              updatedAt: null,
              freshnessMinutes: null,
              status: "missing" as const,
              expectedCadenceMinutes: 360,
              graceMinutes: 180
            }]
          : window.sourceFreshness
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(forecastWithFutureGap);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    const indicator = await screen.findByTestId("source-status");
    expect(indicator.classList.contains("degraded")).toBe(false);
    expect(indicator.textContent).not.toContain("unavailable");
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
    const otherSpot = { ...spot, id: "other-break", name: "Other Break" } satisfies ApiSpot;
    const catalog = {
      spots: [spot, otherSpot],
      sourceNote: "DOM-test age range catalog."
    } satisfies SpotsResponse;
    const firstForecast = forecastWithSourceAge(spot, 181);
    const otherForecast = forecastWithSourceAge(otherSpot, 200);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(catalog);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(firstForecast);
      if (path === `/api/forecast/${otherSpot.id}`) return jsonResponse(otherForecast);
      if (path.startsWith(`/api/forecast/${spot.id}/brief?`)) return jsonResponse({ error: "not generated" }, 404);
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);

    // 181m and 200m both format to "3h": one collapsed value, never "3h–3h".
    expect(await screen.findByText("Source data 3h old")).toBeTruthy();
  });

  it("renders a genuine chip range when ages format differently", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const otherSpot = { ...spot, id: "other-break", name: "Other Break" } satisfies ApiSpot;
    const catalog = {
      spots: [spot, otherSpot],
      sourceNote: "DOM-test age range catalog."
    } satisfies SpotsResponse;
    const firstForecast = forecastWithSourceAge(spot, 45);
    const otherForecast = forecastWithSourceAge(otherSpot, 300);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(catalog);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse(firstForecast);
      if (path === `/api/forecast/${otherSpot.id}`) return jsonResponse(otherForecast);
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

  it("keeps multiple late-source ages out of the steady-state banner", async () => {
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

    const { container } = render(<App />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
  });

  it("does not turn a spot-specific source age into a regional banner", async () => {
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

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
    expect(container.querySelector(".noticeBanner")).toBeNull();
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
    const surfGraph = await screen.findByRole("img", { name: "Stepped surf-size estimate chart" });
    fireEvent.keyDown(surfGraph, { key: "Home" });
    const firstChartAt = new URLSearchParams(window.location.search).get("at");
    expect(firstChartAt).toBeTruthy();
    fireEvent.keyDown(surfGraph, { key: "End" });
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("at")).not.toBe(firstChartAt);
    });
    expect(document.getElementById("forecast-graph-selection")?.textContent).toContain("selected");

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
      expect(container.querySelector(".spotCall")?.textContent).toContain("surf with");
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
      expect(container.querySelector(".spotCall")?.textContent).toContain("surf with");
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
