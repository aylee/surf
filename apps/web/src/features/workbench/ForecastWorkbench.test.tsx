/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ForecastResponseSchema, type ApiSpot, type ForecastResponse } from "@surf/contracts";
import { getSpotProfile, selectCanonicalRecommendationIds } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptForecastResponse } from "./forecast-adapter";
import {
  ForecastWorkbench,
  bestCanonicalDayWindow,
  displayedCanonicalWindow
} from "./ForecastWorkbench";

const now = new Date("2026-08-02T07:00:00.000Z");
const canonicalThreeHourAt = "2026-08-02T16:00:00.000Z";
const hourlyChallengerAt = "2026-08-02T17:00:00.000Z";
// Past the fixture's entire five-day horizon: every daylight window has
// elapsed, so the local canonical recommendation is empty while the forecast
// payload itself stays healthy and usable.
const elapsedDayNow = new Date("2026-08-12T23:00:00.000Z");
const profile = getSpotProfile("bolinas");
const spot = {
  ...profile,
  sourceMap: {
    nwsWaveGrid: {
      provider: "NOAA/NWS MTR",
      forecastGridData: "https://api.weather.gov/gridpoints/MTR/85,105",
      breakingHeightScale: 1,
      notes: "Test source"
    },
    observedWave: [{ provider: "NDBC", stationId: "46237", name: "San Francisco Bar" }],
    coopsTide: { stationId: "9414958", name: "Bolinas Lagoon" }
  }
} satisfies ApiSpot;

function fixtureForecast(): ForecastResponse {
  const fixture = buildFixtureForecast("bolinas", now);
  return ForecastResponseSchema.parse({
    ...fixture,
    interval: "3h",
    windows: fixture.windows.map((window) => ({
      ...window,
      sourceFreshness: [
        {
          capability: "forecast_wave_offshore",
          sourceId: "wave:test",
          sourceRunId: "wave-run",
          updatedAt: "2026-08-02T06:40:00.000Z",
          freshnessMinutes: 20,
          status: "fresh"
        },
        {
          capability: "observed_wave",
          sourceId: "buoy:test",
          sourceRunId: null,
          updatedAt: null,
          freshnessMinutes: null,
          status: "missing"
        }
      ]
    }))
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

function canonicalThreeHourForecast(): ForecastResponse {
  const fixture = fixtureForecast();
  return ForecastResponseSchema.parse({
    ...fixture,
    interval: "3h",
    windows: fixture.windows.map((window) => ({
      ...window,
      surfaceCondition: window.forecastAt === canonicalThreeHourAt ? "clean" : "choppy",
      score: window.forecastAt === canonicalThreeHourAt ? 82 : 12,
      confidence: window.forecastAt === canonicalThreeHourAt ? 88 : 60
    }))
  });
}

function hourlyForecastWithLocalChallenger(threeHour: ForecastResponse): ForecastResponse {
  const localDayStart = new Date("2026-08-02T07:00:00.000Z").getTime();
  const hourMs = 60 * 60 * 1000;
  const windows = Array.from({ length: 24 }, (_, localHour) => {
    const forecastAt = new Date(localDayStart + localHour * hourMs).toISOString();
    const sourceHour = Math.floor(localHour / 3) * 3;
    const validFrom = new Date(localDayStart + sourceHour * hourMs).toISOString();
    const validTo = new Date(localDayStart + (sourceHour + 3) * hourMs).toISOString();
    const source = threeHour.windows.find((window) => window.forecastAt === validFrom);
    if (!source) throw new Error(`Missing three-hour source window for ${validFrom}`);
    const isChallenger = forecastAt === hourlyChallengerAt;
    return {
      ...source,
      forecastAt,
      surfaceCondition: isChallenger ? "clean" as const : "choppy" as const,
      score: isChallenger ? 100 : 5,
      confidence: isChallenger ? 100 : 55,
      waveState: {
        semantics: "nws_fallback" as const,
        calibrationStatus: "cold_start_uncalibrated" as const,
        validFrom,
        validTo,
        sourceResolutionHours: 3,
        modeledNearshoreHeightFt: source.waveHeightFt,
        breakingSurfHeightFt: null,
        periodSec: source.peakPeriodSec,
        directionDeg: source.primaryDirectionDeg
      },
      resolution: {
        wave: {
          sourceIntervalMinutes: 180,
          displayIntervalMinutes: 60,
          method: localHour % 3 === 0 ? "exact" as const : "held" as const,
          validFrom,
          validTo
        },
        wind: {
          sourceIntervalMinutes: 60,
          displayIntervalMinutes: 60,
          method: "exact" as const,
          validFrom: forecastAt,
          validTo: new Date(new Date(forecastAt).getTime() + hourMs).toISOString()
        },
        tide: {
          sourceIntervalMinutes: 60,
          displayIntervalMinutes: 60,
          method: "exact" as const,
          validFrom: forecastAt,
          validTo: new Date(new Date(forecastAt).getTime() + hourMs).toISOString()
        }
      }
    };
  });
  return ForecastResponseSchema.parse({ ...threeHour, interval: "1h", windows });
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("ForecastWorkbench", () => {
  it("distinguishes an authoritative empty recommendation list from legacy omission", () => {
    const adapted = adaptForecastResponse(canonicalThreeHourForecast(), spot, "3h");

    expect(bestCanonicalDayWindow(adapted.windows, now, "2026-08-02", [])).toBeUndefined();
    expect(
      bestCanonicalDayWindow(adapted.windows, now, "2026-08-02", null)?.forecastAt
    ).toBe(canonicalThreeHourAt);
  });

  it("labels an authoritative no-call day as having no remaining window", async () => {
    const forecast = ForecastResponseSchema.parse({
      ...fixtureForecast(),
      recommendations: []
    });

    render(<ForecastWorkbench spot={spot} initialForecast={forecast} now={now} />);

    expect((await screen.findAllByText("No remaining window")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Inputs incomplete")).toBeNull();
  });

  it("maps a canonical hourly time through display intervals rather than wave validity", () => {
    const base = adaptForecastResponse(canonicalThreeHourForecast(), spot, "3h").windows[0]!;
    const canonical = {
      ...base,
      forecastAt: "2026-08-02T15:00:00.000Z",
      localDateKey: "2026-08-02",
      localHour: 8
    };
    const sixAm = {
      ...base,
      forecastAt: "2026-08-02T13:00:00.000Z",
      localDateKey: "2026-08-02",
      localHour: 6,
      validFrom: "2026-08-02T12:00:00.000Z",
      validTo: "2026-08-02T15:00:00.000Z"
    };
    const nineAm = {
      ...base,
      forecastAt: "2026-08-02T16:00:00.000Z",
      localDateKey: "2026-08-02",
      localHour: 9,
      validFrom: "2026-08-02T15:00:00.000Z",
      validTo: "2026-08-02T18:00:00.000Z"
    };

    expect(displayedCanonicalWindow(canonical, [sixAm, nineAm], "3h")?.forecastAt).toBe(
      sixAm.forecastAt
    );
  });

  it("does not mark a civil-light-overlapping published best row as night", async () => {
    const base = buildFixtureForecast("bolinas", new Date("2026-12-10T08:00:00.000Z"));
    const displayRow = base.windows.find(
      (window) => window.forecastAt === "2026-12-10T14:00:00.000Z"
    )!;
    const representative = {
      ...displayRow,
      forecastAt: "2026-12-10T15:00:00.000Z"
    };
    const forecast = ForecastResponseSchema.parse({
      ...base,
      interval: "3h",
      sunPhases: [{
        localDate: "2026-12-10",
        firstLight: "2026-12-10T15:22:00.000Z",
        sunrise: "2026-12-10T15:50:00.000Z",
        sunset: "2026-12-11T00:50:00.000Z",
        lastLight: "2026-12-11T01:19:00.000Z"
      }],
      recommendations: [{
        localDate: "2026-12-10",
        representative,
        constituentWindowIds: [representative.forecastAt],
        startAt: "2026-12-10T15:22:00.000Z",
        endAt: "2026-12-10T16:00:00.000Z"
      }]
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({}, 503)));

    render(
      <ForecastWorkbench
        spot={{ ...spot, id: "bolinas", name: "Bolinas" }}
        initialForecast={forecast}
        now={new Date("2026-12-10T13:00:00.000Z")}
      />
    );

    const selectedRow = await screen.findByTestId("forecast-row-2026-12-10T14:00:00.000Z");
    expect(selectedRow.classList.contains("selectedRow")).toBe(true);
    expect(selectedRow.classList.contains("nightRow")).toBe(false);
    expect(selectedRow.querySelector('[aria-label="Night window"]')).toBeNull();
  });

  it("keeps the canonical three-hour recommendation after switching to a locally stronger hourly row", async () => {
    const threeHour = canonicalThreeHourForecast();
    const oneHour = hourlyForecastWithLocalChallenger(threeHour);
    const adaptedHourly = adaptForecastResponse(oneHour, spot, "1h");
    const hourlyWinner = selectCanonicalRecommendationIds(
      adaptedHourly.windows.map((window) => ({
        windowId: window.forecastAt,
        forecastAt: window.forecastAt,
        isDaylight: window.isDaylight,
        ratingStatus: window.raw.ratingStatus,
        surfaceCondition: window.condition,
        score: window.raw.score,
        confidence: window.confidence
      })),
      now
    )[0];
    expect(hourlyWinner).toBe(hourlyChallengerAt);

    window.history.replaceState({}, "", "/?spot=bolinas");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) return jsonResponse(oneHour);
      if (url.includes("interval=3h")) return jsonResponse(threeHour);
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={threeHour} now={now} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Analysis" }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("at")).toBe(canonicalThreeHourAt);
      expect(params.get("tab")).toBe("analysis");
    });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), { button: 0, ctrlKey: false });
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("tab")).toBeNull();
    });
    fireEvent.click(await screen.findByRole("radio", { name: "One-hour resolution" }));

    expect(await screen.findByRole("table", { name: /One-hour surf-planning inputs for Bolinas/ })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId(`forecast-row-${canonicalThreeHourAt}`).classList.contains("selectedRow")).toBe(true);
      expect(screen.getByTestId(`forecast-row-${hourlyChallengerAt}`).classList.contains("selectedRow")).toBe(false);
      const params = new URLSearchParams(window.location.search);
      expect(params.get("interval")).toBe("1h");
      expect(params.get("at")).toBe(canonicalThreeHourAt);
    });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Analysis" }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
  });

  it("renders only a validated v3 Analysis report with three compact paragraphs", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      jsonResponse({
        schemaVersion: 3,
        status: "published",
        report: {
          schemaVersion: 3,
          spotId: "bolinas",
          localDate: "2026-08-02",
          revisionId: "revision.fixture",
          headline: "Bolinas: Sunday 9:00 AM leads",
          paragraphs: [
            "Surf holds near 2–3 ft through daylight; swell holds near west swell.",
            "The top deterministic session is Sunday 9:00 AM: 2–3 ft surf, light offshore wind; high tide at 10:00 AM.",
            "The call carries medium confidence. Main bust factor: Wind may arrive early."
          ],
          updatedAt: "2026-08-02T12:00:00.000Z"
        },
        availableRevisions: 1
      })
    ));

    const { container } = render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />
    );

    expect(await screen.findByRole("heading", { name: "Bolinas: Sunday 9:00 AM leads" })).toBeTruthy();
    expect(container.querySelectorAll(".dailyAnalysisParagraphs p")).toHaveLength(3);
    expect(screen.queryByText(/deterministic fallback|AI-assisted|revision/i)).toBeNull();
  });

  it("fails closed to honest unavailable Analysis while keeping forecast rows usable", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "provider unavailable" }, 503)
    ));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);

    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    expect(screen.getByText("No validated report is available for this forecast.")).toBeTruthy();
    expect(screen.queryByText(/provider unavailable|deterministic fallback/i)).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), {
      button: 0,
      ctrlKey: false
    });
    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
  });

  it("does not render placeholder wind direction or speed when wind is unavailable", async () => {
    const forecast = ForecastResponseSchema.parse({
      ...fixtureForecast(),
      windows: fixtureForecast().windows.map((window) => ({
        ...window,
        windSpeedKt: 0,
        windDirectionDeg: null
      }))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({}, 503)));

    render(<ForecastWorkbench spot={spot} initialForecast={forecast} now={now} />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.getAllByText("Wind unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText("— 0 kt")).toBeNull();
  });

  it("rejects malformed and legacy brief payloads instead of rendering pseudo-reports", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      jsonResponse({
        status: "deterministic_fallback",
        brief: { headline: "Legacy local read", provider: "deterministic" }
      })
    ));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);

    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    expect(screen.queryByText("Legacy local read")).toBeNull();
  });
  it("returns to the last good three-hour view when hourly detail has no usable windows", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas");
    const threeHour = fixtureForecast();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) return jsonResponse(unavailableForecast(threeHour));
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={threeHour} now={now} />);
    fireEvent.click(screen.getByRole("radio", { name: "One-hour resolution" }));

    expect(await screen.findByText("Hourly detail is temporarily unavailable. Showing the latest three-hour forecast.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Three-hour resolution" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("interval")).toBe("3h");
    expect(screen.queryByText("No forecast detail is available for this day.")).toBeNull();
  });

  it("reports elapsed current-day slots missing from a legacy partial payload", async () => {
    const lateNow = new Date("2026-08-03T00:30:00.000Z");
    const currentDay = "2026-08-02";
    const completeForecast = fixtureForecast();
    const retainedWindowIds = new Set(
      adaptForecastResponse(completeForecast, spot, "3h").windows
        .filter((window) => window.localDateKey === currentDay && window.localHour >= 18)
        .map((window) => window.forecastAt)
    );
    const lateForecast = ForecastResponseSchema.parse({
      ...completeForecast,
      windows: completeForecast.windows.filter((window) => retainedWindowIds.has(window.forecastAt))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({ error: "not generated" }, 404)));

    render(<ForecastWorkbench spot={spot} initialForecast={lateForecast} now={lateNow} />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.getByText(/2 of 8 expected 3h windows are available/i)).toBeTruthy();
  });

  it("reports every missing slot in current-day coverage", async () => {
    const lateNow = new Date("2026-08-03T00:30:00.000Z");
    const currentDay = "2026-08-02";
    const completeForecast = fixtureForecast();
    const retainedWindowIds = new Set(
      adaptForecastResponse(completeForecast, spot, "3h").windows
        .filter((window) => window.localDateKey === currentDay && window.localHour === 21)
        .map((window) => window.forecastAt)
    );
    const lateForecast = ForecastResponseSchema.parse({
      ...completeForecast,
      windows: completeForecast.windows.filter((window) => retainedWindowIds.has(window.forecastAt))
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({ error: "not generated" }, 404)));

    render(<ForecastWorkbench spot={spot} initialForecast={lateForecast} now={lateNow} />);

    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.getByText(/1 of 8 expected 3h windows are available/i)).toBeTruthy();
  });

  it("never auto-expands a desktop row and toggles the explanation on click", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas");
    const threeHour = fixtureForecast();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("interval=1h")) return jsonResponse(hourlyForecastWithLocalChallenger(threeHour));
      if (url.includes("interval=3h")) return jsonResponse(threeHour);
      return jsonResponse({}, 503);
    }));

    const { container } = render(<ForecastWorkbench spot={spot} initialForecast={threeHour} now={now} />);

    // A window is auto-SELECTED, but OD-9 forbids an auto-EXPANDED explanation.
    await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ });
    await waitFor(() => {
      expect(container.querySelector(".forecastTable .selectedRow")).toBeTruthy();
    });
    expect(container.querySelector(".forecastTable .selectedDetailRow")).toBeNull();

    const rowButton = container.querySelector<HTMLButtonElement>(".forecastTable tbody th button");
    expect(rowButton?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(rowButton!);
    await waitFor(() => {
      expect(container.querySelector(".forecastTable .selectedDetailRow")).toBeTruthy();
    });
    expect(rowButton?.getAttribute("aria-expanded")).toBe("true");

    // A second click collapses it again.
    fireEvent.click(rowButton!);
    await waitFor(() => {
      expect(container.querySelector(".forecastTable .selectedDetailRow")).toBeNull();
    });
    expect(rowButton?.getAttribute("aria-expanded")).toBe("false");

    // Re-expand, then prove a resolution change clears the expansion.
    fireEvent.click(rowButton!);
    await waitFor(() => expect(container.querySelector(".forecastTable .selectedDetailRow")).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "One-hour resolution" }));
    await screen.findByRole("table", { name: /One-hour surf-planning inputs/ });
    await waitFor(() => {
      expect(container.querySelector(".forecastTable .selectedDetailRow")).toBeNull();
    });
  });

  it("polls a pending Analysis without cache and publishes when the report is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let requests = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      requests += 1;
      return requests === 1
        ? jsonResponse({
            schemaVersion: 3,
            status: "pending",
            report: null,
            message: "Analysis is being prepared.",
            availableRevisions: 0
          })
        : jsonResponse({
            schemaVersion: 3,
            status: "published",
            report: {
              schemaVersion: 3,
              spotId: "bolinas",
              localDate: "2026-08-02",
              revisionId: "revision.polled",
              headline: "Bolinas: the best window is ready",
              paragraphs: ["Setup paragraph.", "Plan paragraph.", "Confidence paragraph."],
              updatedAt: "2026-08-02T12:00:00.000Z"
            },
            availableRevisions: 1
          });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);

    expect(await screen.findByText("Analysis is being prepared.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /leading daylight window/i })).toBeNull();
    expect(screen.queryByText(/deterministic fallback/i)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(
      await screen.findByRole("heading", { name: "Bolinas: the best window is ready" })
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.cache === "no-store")
    ).toBe(true);
  });

  it("polls pending Analysis into the Worker's unavailable lifecycle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      requests += 1;
      return jsonResponse(
        requests === 1
          ? {
              schemaVersion: 3,
              status: "pending",
              report: null,
              message: "Analysis is being prepared.",
              availableRevisions: 0
            }
          : {
              schemaVersion: 3,
              status: "unavailable",
              report: null,
              message: "Analysis unavailable",
              detail: "No validated report is available for this forecast.",
              availableRevisions: 0
            }
      );
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);
    expect(await screen.findByText("Analysis is being prepared.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    expect(requests).toBe(2);
  });

  it("ends an always-pending Analysis as unavailable after exactly 20 requests", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        schemaVersion: 3,
        status: "pending",
        report: null,
        message: "Analysis is being prepared.",
        availableRevisions: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);
    expect(await screen.findByText("Analysis is being prepared.")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19 * 3_000);
    });

    const unavailable = await screen.findByText("Analysis unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(unavailable.closest('[role="status"]')?.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByText("Analysis is being prepared.")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("cancels pending Analysis polling when the panel is no longer visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        schemaVersion: 3,
        status: "pending",
        report: null,
        message: "Analysis is being prepared.",
        availableRevisions: 0
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);
    expect(await screen.findByText("Analysis is being prepared.")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), {
      button: 0,
      ctrlKey: false
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the exact unavailable Analysis state returned by the Worker", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      jsonResponse({
        schemaVersion: 3,
        status: "unavailable",
        report: null,
        message: "Analysis unavailable",
        detail: "No validated report is available for this forecast.",
        availableRevisions: 0
      })
    ));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);

    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    expect(screen.getByText("No validated report is available for this forecast.")).toBeTruthy();
  });

  it("keeps the day picker above both tabs so Analysis can change dates", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      requestedUrls.push(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      return jsonResponse({
        schemaVersion: 3,
        status: "unavailable",
        report: null,
        message: "Analysis unavailable",
        detail: "No validated report is available for this forecast.",
        availableRevisions: 0
      });
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);
    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    const picker = screen.getByLabelText("Forecast day");
    const spotTabs = screen.getByRole("tablist", { name: "Spot view" });
    expect(
      picker.compareDocumentPosition(spotTabs) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const provenance = screen.getByText("Data, confidence & provenance");
    expect(
      spotTabs.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const dayButtons = picker.querySelectorAll("button");
    expect(dayButtons.length).toBeGreaterThan(1);
    fireEvent.click(dayButtons[1]!);

    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("tab")).toBe("analysis");
      const selectedDate = new URLSearchParams(window.location.search).get("date");
      expect(selectedDate).toBeTruthy();
      expect(requestedUrls.at(-1)).toContain(`date=${selectedDate}`);
    });
  });

  it("keeps a published v3 report reachable after the selected day's windows elapsed", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () =>
      jsonResponse({
        schemaVersion: 3,
        status: "published",
        report: {
          schemaVersion: 3,
          spotId: "bolinas",
          localDate: "2026-08-02",
          revisionId: "revision.elapsed",
          headline: "A validated report remains available",
          paragraphs: [
            "Surf holds through the selected daylight period.",
            "The published top session remains the validated historical call.",
            "Confidence remains tied to that exact forecast generation."
          ],
          updatedAt: "2026-08-02T12:00:00.000Z"
        },
        availableRevisions: 1
      })
    ));

    render(
      <ForecastWorkbench
        spot={spot}
        initialForecast={fixtureForecast()}
        now={elapsedDayNow}
      />
    );

    expect(
      await screen.findByRole("heading", { name: "A validated report remains available" })
    ).toBeTruthy();
    expect(screen.getByText("Confidence remains tied to that exact forecast generation.")).toBeTruthy();
  });
  it("says so on Analysis when the forecast request itself failed", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({ error: "unavailable" }, 503)));

    render(
      <ForecastWorkbench spot={spot} initialForecast={null} initialError="forecast failed" now={now} />
    );

    // The panel must not claim the sibling tab has data when it is showing an
    // error, and the honest lifecycle state must be announced.
    const line = await screen.findByText("Analysis unavailable");
    expect(line.closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByText(/still listed on the Forecast tab/)).toBeNull();
  });

  it("uses one hourly request while a cold three-hour fallback arrives", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&interval=1h");
    const threeHour = fixtureForecast();
    let hourlyRequests = 0;
    let releaseCanonical!: () => void;
    const canonicalGate = new Promise<void>((resolve) => {
      releaseCanonical = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) {
        hourlyRequests += 1;
        return jsonResponse({ error: "hourly unavailable" }, 503);
      }
      if (url.includes("interval=3h")) {
        await canonicalGate;
        return jsonResponse(threeHour);
      }
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={null} now={now} />);
    await waitFor(() => expect(hourlyRequests).toBe(1));

    releaseCanonical();

    expect(await screen.findByText("Hourly detail is temporarily unavailable. Showing the latest three-hour forecast.")).toBeTruthy();
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(hourlyRequests).toBe(1);
    expect(new URLSearchParams(window.location.search).get("interval")).toBe("3h");
  });

  it("does not restart a cold canonical backfill when hourly detail arrives first", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&interval=1h");
    const threeHour = canonicalThreeHourForecast();
    const oneHour = hourlyForecastWithLocalChallenger(threeHour);
    let canonicalRequests = 0;
    let releaseCanonical!: () => void;
    const canonicalGate = new Promise<void>((resolve) => {
      releaseCanonical = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) return jsonResponse(oneHour);
      if (url.includes("interval=3h")) {
        canonicalRequests += 1;
        await canonicalGate;
        return jsonResponse(threeHour);
      }
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={null} now={now} />);

    expect(await screen.findByRole("table", { name: /One-hour surf-planning inputs/ })).toBeTruthy();
    expect(canonicalRequests).toBe(1);
    releaseCanonical();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Analysis" }), { button: 0, ctrlKey: false });
    expect(await screen.findByText("Analysis unavailable")).toBeTruthy();
    expect(canonicalRequests).toBe(1);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("table", { name: /One-hour surf-planning inputs/ })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("interval")).toBe("1h");
  });

  it("invalidates and refetches the active hourly cache when the canonical forecast changes", async () => {
    const firstThreeHour = canonicalThreeHourForecast();
    const refreshedThreeHour = ForecastResponseSchema.parse({
      ...firstThreeHour,
      generatedAt: "2026-08-02T08:00:00.000Z"
    });
    const oneHour = hourlyForecastWithLocalChallenger(firstThreeHour);
    let hourlyRequests = 0;

    window.history.replaceState({}, "", "/?spot=bolinas");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.includes("interval=1h")) {
        hourlyRequests += 1;
        return jsonResponse(oneHour);
      }
      if (url.includes("interval=3h")) return jsonResponse(refreshedThreeHour);
      return jsonResponse({}, 503);
    }));

    const { rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={firstThreeHour} now={now} />
    );
    fireEvent.click(screen.getByRole("radio", { name: "One-hour resolution" }));
    await waitFor(() => expect(hourlyRequests).toBe(1));
    expect(await screen.findByRole("table", { name: /One-hour surf-planning inputs/ })).toBeTruthy();

    rerender(
      <ForecastWorkbench spot={spot} initialForecast={refreshedThreeHour} now={now} />
    );
    await waitFor(() => expect(hourlyRequests).toBe(2));
  });
});
