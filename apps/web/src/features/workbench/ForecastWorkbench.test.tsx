/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ForecastResponseSchema, type ApiSpot, type ForecastResponse } from "@surf/contracts";
import { getSpotProfile, selectCanonicalRecommendationIds } from "@surf/forecast-core";
import { buildFixtureForecast } from "@surf/forecast-core/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleModelForecastBrief } from "../../../worker/brief/brief";
import { buildForecastFactBundle } from "../../../worker/brief/facts";
import { briefForecastFixture, validDraftFor } from "../../../worker/brief/test-helpers";
import { validateForecastBriefDraft } from "../../../worker/brief/validator";
import { adaptForecastResponse } from "./forecast-adapter";
import { ForecastWorkbench } from "./ForecastWorkbench";

const now = new Date("2026-08-02T07:00:00.000Z");
const canonicalThreeHourAt = "2026-08-02T16:00:00.000Z";
const hourlyChallengerAt = "2026-08-02T17:00:00.000Z";
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
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("ForecastWorkbench", () => {
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
    expect(await screen.findByRole("heading", { name: "9:00 AM is the leading daylight window" })).toBeTruthy();
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
    expect(await screen.findByRole("heading", { name: "9:00 AM is the leading daylight window" })).toBeTruthy();
  });

  it("hides stale-brief internals, shows selected-source states, and lets a phone row collapse", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({
      status: "stale",
      fallbackReason: "Forecast inputs changed materially.",
      availableRevisions: 4,
      brief: {
        provider: "deterministic",
        headline: "Use the current deterministic read",
        setup: "The prior model brief no longer matches the public inputs.",
        revision: 4,
        generatedAt: "2026-08-02T07:05:00.000Z",
        picks: [{
          windowId: "window:1",
          label: "First-light option",
          why: "The supported score leads.",
          tradeoff: "The buoy observation is missing.",
          factRefs: ["window:1"]
        }],
        bustFactors: [],
        lesson: { topic: "Freshness", text: "Read source state per selected time.", factRefs: ["source:1"] }
      }
    })));

    const { container } = render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />
    );

    expect(await screen.findByText("First-light option")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Use the current forecast read" })).toBeTruthy();
    expect(container.querySelector(".dailyBrief")?.textContent?.toLowerCase()).not.toContain("deterministic");
    expect(screen.queryByText("Stale · deterministic")).toBeNull();
    expect(screen.queryByText("Forecast inputs changed materially.")).toBeNull();
    expect(screen.queryByText(/deterministic fallback/i)).toBeNull();
    expect(screen.queryByText(/Generated Aug 2/)).toBeNull();
    expect(screen.queryByText("AI explanation")).toBeNull();
    expect(screen.queryByText("Revision 4")).toBeNull();

    fireEvent.click(screen.getByText("Data, confidence & provenance").closest("button")!);
    expect(await screen.findByText("Fresh")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();

    // Rows never auto-expand (OD-9); a phone row opens on tap and collapses
    // on a second tap while the selection highlight stays.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), { button: 0, ctrlKey: false });
    await waitFor(() => {
      expect(container.querySelector(".mobileForecastRows .uiAccordionTrigger[data-state='open']")).toBeNull();
    });
    const collapsedTrigger = container.querySelector<HTMLButtonElement>(
      ".mobileForecastRows .uiAccordionTrigger"
    );
    expect(collapsedTrigger).toBeTruthy();
    fireEvent.click(collapsedTrigger!);
    await waitFor(() => expect(collapsedTrigger?.getAttribute("data-state")).toBe("open"));
    fireEvent.click(collapsedTrigger!);
    await waitFor(() => expect(collapsedTrigger?.getAttribute("data-state")).toBe("closed"));
    expect(container.querySelector(".mobileForecastRows .uiAccordionItem.selectedRow")).toBeTruthy();
  });

  it("keeps the local outlook and workbench usable when the brief request fails", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({ error: "provider unavailable" }, 503)));
    const choppyForecast = fixtureForecast();
    choppyForecast.windows = choppyForecast.windows.map((window) => ({
      ...window,
      surfaceCondition: "choppy" as const,
      qualityLabel: "poor" as const
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={choppyForecast} now={now} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Analysis" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("heading", { name: /leading daylight window/ })).toBeTruthy();
    expect(screen.queryByText(/clearest daylight window/i)).toBeNull();
    expect(screen.getByText(/Outlook updated Aug 2/)).toBeTruthy();
    expect(screen.queryByText(/deterministic fallback/i)).toBeNull();
    expect(screen.queryByText(/provider unavailable/i)).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("presents one best window, quieter alternatives, and no provider-specific chrome", async () => {
    const modelForecast = briefForecastFixture();
    modelForecast.spot = {
      ...modelForecast.spot,
      id: spot.id,
      name: spot.name,
      timezone: spot.timezone
    };
    const bundle = await buildForecastFactBundle(modelForecast);
    const { draft } = validateForecastBriefDraft(validDraftFor(bundle), bundle);
    const modelBrief = assembleModelForecastBrief({
      bundle,
      draft,
      revision: 1,
      generatedAt: "2026-08-02T19:23:58.459Z"
    });
    const [bestPick, alternatePick] = modelBrief.picks;
    expect(bestPick).toBeDefined();
    expect(alternatePick).toBeDefined();
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({
      status: "model",
      brief: modelBrief
    })));

    const { container } = render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />
    );

    expect(await screen.findByRole("heading", { name: modelBrief.headline })).toBeTruthy();
    expect(screen.getByText("Best window")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: bestPick!.label })).toBeTruthy();
    expect(screen.getByText("Also worth a look")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: alternatePick!.label })).toBeTruthy();
    expect(screen.getAllByText("Why")).toHaveLength(2);
    expect(screen.getAllByText("Watch for")).toHaveLength(2);
    expect(screen.queryByText("AI-assisted")).toBeNull();
    expect(container.querySelector(".dailyBriefIcon")).toBeNull();

    const lessonSummary = screen.getByText("What this teaches you").closest("summary");
    const lesson = lessonSummary?.closest("details") as HTMLDetailsElement | null;
    expect(lesson?.open).toBe(false);
    fireEvent.click(lessonSummary!);
    expect(lesson?.open).toBe(true);
    expect(screen.getByText(modelBrief.lesson.text)).toBeTruthy();
  });

  it("ignores malformed brief timestamps without collapsing forecast detail", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({
      status: "model",
      brief: {
        provider: "google",
        headline: "A validated daily read",
        setup: "The public inputs support the selected window.",
        generatedAt: "not-a-timestamp",
        picks: [],
        bustFactors: []
      }
    })));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={now} />);

    expect(await screen.findByRole("heading", { name: "A validated daily read" })).toBeTruthy();
    expect(screen.queryByText("AI-assisted")).toBeNull();
    expect(screen.queryByText(/time unavailable/i)).toBeNull();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Forecast" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
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

  it("does not report elapsed current-day slots as missing coverage", async () => {
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
    expect(screen.queryByText(/2 of 8 expected 3h windows/i)).toBeNull();
    expect(screen.queryByText(/expected 3h windows are available/i)).toBeNull();
  });

  it("reports a missing leading slot in the remaining current-day coverage", async () => {
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
    expect(screen.getByText(/1 of 2 expected 3h windows are available/i)).toBeTruthy();
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

  it("collapses a forecaster with no reliable call to one quiet line and skips the brief fetch", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) briefRequests += 1;
      return jsonResponse({}, 503);
    }));

    const { container } = render(
      <ForecastWorkbench spot={spot} initialForecast={unavailableForecast(fixtureForecast())} now={now} />
    );

    expect(
      await screen.findByText(/No reliable daylight recommendation yet — the Forecast tab still shows every available public input\./)
    ).toBeTruthy();
    // One quiet line, not a billboard: no brief headline, picks, or lesson.
    expect(container.querySelector(".dailyBrief")).toBeNull();
    expect(screen.queryByText("What this teaches you")).toBeNull();
    expect(screen.queryByText("Daily outlook")).toBeNull();
    expect(briefRequests).toBe(0);
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
    await waitFor(() => expect(screen.getByRole("heading", { name: /leading daylight window/ })).toBeTruthy());
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
