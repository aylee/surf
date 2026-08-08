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

  it("collapses to one quiet line when the Worker answers with no outlook to publish", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        // A 2xx answer carrying nothing publishable: the deterministic "no
        // recommendation" case, distinct from a request that never landed.
        return jsonResponse({ status: "unavailable", brief: null });
      }
      return jsonResponse({}, 503);
    }));

    const { container } = render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={elapsedDayNow} />
    );

    expect(
      await screen.findByText(/No daylight recommendation for this day\. Every available public input is still listed on the Forecast tab\./)
    ).toBeTruthy();
    // One quiet line, not a billboard: no headline, picks, or lesson.
    expect(container.querySelector(".dailyBrief")).toBeNull();
    expect(screen.queryByText("What this teaches you")).toBeNull();
    expect(screen.queryByText("Daily outlook")).toBeNull();
    // The request still fires — a published brief must stay reachable even
    // when the local read has no pick; only its absence collapses the panel.
    await waitFor(() => expect(briefRequests).toBeGreaterThan(0));
  });

  it("distinguishes a failed outlook request from a deterministic no-recommendation", async () => {
    // Elapsed day, healthy cached payload, brief endpoint down. Presenting this
    // as "no daylight recommendation" would state an editorial judgment the
    // Worker never made — and would hide a published brief behind a transport
    // failure.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) briefRequests += 1;
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={elapsedDayNow} />);

    expect(
      await screen.findByText(/The daily outlook could not be loaded\. Every available public input is still listed on the Forecast tab\./)
    ).toBeTruthy();
    expect(screen.queryByText(/No daylight recommendation for this day/)).toBeNull();
    await waitFor(() => expect(briefRequests).toBeGreaterThan(0));
  });

  it("never claims a failed outlook while the forecast payload is still in flight", async () => {
    // The mirror of the outage case: a brief that failed says nothing about a
    // payload that has not landed, and the failure copy would claim inputs are
    // listed on a Forecast tab that is still empty.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis&date=2026-08-02");
    let releaseForecast!: () => void;
    const forecastGate = new Promise<void>((resolve) => { releaseForecast = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) return jsonResponse({}, 503);
      await forecastGate;
      return jsonResponse(fixtureForecast());
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={null} now={now} />);

    expect(await screen.findByText("Loading the daily outlook…")).toBeTruthy();
    expect(screen.queryByText(/still listed on the Forecast tab/)).toBeNull();

    releaseForecast();
    // The payload carries a daylight pick, so the panel resolves to content —
    // proving the failure line would have been retracted had it been shown.
    expect(await screen.findByRole("heading", { name: /leading daylight window/ })).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it("never claims an outage while its own brief request is still in flight", async () => {
    // The brief is a separate endpoint that answers even when the forecast read
    // is failing, so the outage line must not preempt an in-flight request it
    // would have to retract one round trip later.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis&date=2026-08-02");
    let releaseBrief!: () => void;
    const briefGate = new Promise<void>((resolve) => { releaseBrief = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        await briefGate;
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: "The outlook survived the outage",
            setup: "The brief endpoint answered while the forecast read was failing.",
            revision: 1,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    render(
      <ForecastWorkbench spot={spot} initialForecast={null} initialError="forecast failed" now={now} />
    );

    expect(await screen.findByText("Loading the daily outlook…")).toBeTruthy();
    expect(screen.queryByText(/Forecast data for this spot is temporarily unavailable/)).toBeNull();

    releaseBrief();
    expect(await screen.findByRole("heading", { name: "The outlook survived the outage" })).toBeTruthy();
    expect(screen.queryByText(/Forecast data for this spot is temporarily unavailable/)).toBeNull();
  });

  it("keeps a published brief reachable on a day whose daylight windows have elapsed", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: "Yesterday's window has closed",
            setup: "The published outlook and its caveats remain available for review.",
            revision: 1,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [{ text: "Afternoon wind arrived early.", factRefs: ["wind:1"] }],
            lesson: { topic: "Timing", text: "A closed window still teaches what moved the call.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={elapsedDayNow} />
    );

    // No local pick exists, but the Worker's brief must still render rather
    // than being suppressed behind the quiet line.
    expect(await screen.findByRole("heading", { name: "Yesterday's window has closed" })).toBeTruthy();
    expect(screen.getByText("What could change the call")).toBeTruthy();
    expect(screen.queryByText(/No daylight recommendation for this day/)).toBeNull();
  });

  it("labels the outlook with its own day and never denies a recommendation while the brief is in flight", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let releaseBrief!: () => void;
    const briefGate = new Promise<void>((resolve) => { releaseBrief = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        await briefGate;
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: "A published outlook",
            setup: "Public inputs support the read.",
            revision: 1,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={elapsedDayNow} />);

    // The day picker lives on the Forecast tab, so Analysis must name its day.
    expect(await screen.findByText(/^Outlook for /)).toBeTruthy();
    // In flight: a neutral loading status, never the "no recommendation" denial.
    expect(await screen.findByText("Loading the daily outlook…")).toBeTruthy();
    expect(screen.queryByText(/No daylight recommendation for this day/)).toBeNull();

    releaseBrief();
    expect(await screen.findByRole("heading", { name: "A published outlook" })).toBeTruthy();
    expect(screen.queryByText("Loading the daily outlook…")).toBeNull();
  });

  it("refetches the brief when a refreshed payload advances the canonical generation", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: `Revision ${briefRequests}`,
            setup: "Public inputs support the read.",
            revision: briefRequests,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    const first = fixtureForecast();
    const { rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={first} now={elapsedDayNow} />
    );
    expect(await screen.findByRole("heading", { name: "Revision 1" })).toBeTruthy();

    // A dashboard refresh that advances the payload must pick up a newer brief
    // revision while this tab stays open.
    const refreshed = ForecastResponseSchema.parse({ ...first, generatedAt: "2026-08-02T08:00:00.000Z" });
    rerender(<ForecastWorkbench spot={spot} initialForecast={refreshed} now={elapsedDayNow} />);

    expect(await screen.findByRole("heading", { name: "Revision 2" })).toBeTruthy();
    expect(briefRequests).toBe(2);
  });

  it("keeps the published outlook on screen through a refresh and a failed refetch", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        // The refetch triggered by the refreshed payload fails.
        if (briefRequests > 1) return jsonResponse({ error: "brief unavailable" }, 503);
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: "A published outlook",
            setup: "Public inputs support the read.",
            revision: 1,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    const first = fixtureForecast();
    const { rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={first} now={elapsedDayNow} />
    );
    expect(await screen.findByRole("heading", { name: "A published outlook" })).toBeTruthy();

    const refreshed = ForecastResponseSchema.parse({ ...first, generatedAt: "2026-08-02T08:00:00.000Z" });
    rerender(<ForecastWorkbench spot={spot} initialForecast={refreshed} now={elapsedDayNow} />);

    await waitFor(() => expect(briefRequests).toBe(2));
    // A generation-driven refresh must not blank the card, and a failed
    // refetch must not erase a good published outlook or deny it.
    expect(screen.getByRole("heading", { name: "A published outlook" })).toBeTruthy();
    expect(screen.queryByText("Loading the daily outlook…")).toBeNull();
    expect(screen.queryByText(/No daylight recommendation for this day/)).toBeNull();
  });

  it("omits the outlook day label when the URL date is not a real calendar day", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis&date=2026-02-31");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({}, 503)));

    render(<ForecastWorkbench spot={spot} initialForecast={null} initialError="forecast failed" now={now} />);

    // Feb 31 must not be rendered as a confident "Tuesday, Mar 3".
    await screen.findByText(/Forecast data for this spot is temporarily unavailable/);
    expect(screen.queryByText(/^Outlook for /)).toBeNull();
    expect(screen.queryByText(/Mar 3/)).toBeNull();
  });

  it("reports loading, not an outage, while a healthy interval request is in flight", async () => {
    // Hourly resolution with no cached 1h payload: the panel has no forecast
    // yet, but nothing has failed. Claiming an outage here is the state the
    // convergence pass rejected.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis&interval=1h");
    let releaseHourly!: () => void;
    const hourlyGate = new Promise<void>((resolve) => { releaseHourly = resolve; });
    const threeHour = fixtureForecast();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("interval=1h")) {
        await hourlyGate;
        return jsonResponse(hourlyForecastWithLocalChallenger(threeHour));
      }
      if (url.includes("interval=3h")) return jsonResponse(threeHour);
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={null} now={elapsedDayNow} />);

    expect(await screen.findByText("Loading the daily outlook…")).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
    releaseHourly();
  });

  it("keeps the provenance disclosure mounted while an hourly payload refetches", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis&interval=1h");
    const threeHour = fixtureForecast();
    let releaseHourly!: () => void;
    const hourlyGate = new Promise<void>((resolve) => { releaseHourly = resolve; });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("interval=1h")) {
        await hourlyGate;
        return jsonResponse(hourlyForecastWithLocalChallenger(threeHour));
      }
      if (url.includes("interval=3h")) return jsonResponse(threeHour);
      return jsonResponse({}, 503);
    }));

    render(<ForecastWorkbench spot={spot} initialForecast={threeHour} now={now} />);

    // The active-interval payload is still in flight, but the canonical one is
    // in hand — provenance must not vanish from the tab.
    expect(await screen.findByText("Data, confidence & provenance")).toBeTruthy();
    releaseHourly();
    expect(await screen.findByText("Data, confidence & provenance")).toBeTruthy();
  });

  it("does not announce an update when a brief refetch returns nothing", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        if (briefRequests > 1) return jsonResponse({ error: "brief unavailable" }, 503);
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: "A published outlook",
            setup: "Public inputs support the read.",
            revision: 1,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    const first = fixtureForecast();
    const { container, rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={first} now={elapsedDayNow} />
    );
    await screen.findByRole("heading", { name: "A published outlook" });

    const refreshed = ForecastResponseSchema.parse({ ...first, generatedAt: "2026-08-02T08:00:00.000Z" });
    rerender(<ForecastWorkbench spot={spot} initialForecast={refreshed} now={elapsedDayNow} />);
    await waitFor(() => expect(briefRequests).toBe(2));

    // The retained card must never claim it updated, and must not flip to busy
    // for a refresh that changed nothing.
    expect(screen.queryByText("Updating the daily outlook.")).toBeNull();
    expect(container.querySelector(".dailyBrief")?.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("heading", { name: "A published outlook" })).toBeTruthy();
  });

  it("announces a genuine revision by changing the live region's text", async () => {
    // Suppressing the false announcements must not silence the real ones: a
    // polite live region only speaks when its text changes, so a revision that
    // rewrites the card has to rewrite the message too.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: `Revision ${briefRequests}`,
            setup: "Public inputs support the read.",
            revision: briefRequests,
            generatedAt: briefRequests > 1 ? "2026-08-02T09:20:00.000Z" : "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    const first = fixtureForecast();
    const { container, rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={first} now={elapsedDayNow} />
    );
    await screen.findByRole("heading", { name: "Revision 1" });
    const region = () => container.querySelector(".dailyBrief > .srOnly");
    const announced = () => region()?.textContent ?? "";
    const firstAnnouncement = announced();
    expect(firstAnnouncement).toMatch(/^Daily outlook updated\./);
    // Changing text only announces if the node is actually a live region.
    expect(region()?.getAttribute("role")).toBe("status");
    expect(region()?.getAttribute("aria-live")).toBe("polite");

    const refreshed = ForecastResponseSchema.parse({ ...first, generatedAt: "2026-08-02T09:15:00.000Z" });
    rerender(<ForecastWorkbench spot={spot} initialForecast={refreshed} now={elapsedDayNow} />);
    await screen.findByRole("heading", { name: "Revision 2" });

    expect(announced()).toMatch(/^Daily outlook updated\./);
    expect(announced()).not.toBe(firstAnnouncement);
    expect(briefRequests).toBe(2);
  });

  it("stays silent when a refresh republishes the same outlook", async () => {
    // The deterministic paths stamp generatedAt with a materialization or
    // request clock, so keying the announcement on it would announce a revision
    // every time the payload generation moved under identical prose.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        return jsonResponse({
          status: "deterministic_fallback",
          brief: {
            provider: "deterministic",
            headline: "Bolinas daily summary is refreshing",
            setup: "Public inputs support the read.",
            revision: 1,
            // Same prose, later clock: a re-materialization, not a revision.
            generatedAt: briefRequests > 1 ? "2026-08-02T09:20:00.000Z" : "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    const first = fixtureForecast();
    const { container, rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={first} now={elapsedDayNow} />
    );
    await screen.findByRole("heading", { name: "Bolinas daily summary is refreshing" });
    const announced = () => container.querySelector(".dailyBrief > .srOnly")?.textContent ?? "";
    const before = announced();

    const refreshed = ForecastResponseSchema.parse({ ...first, generatedAt: "2026-08-02T09:15:00.000Z" });
    rerender(<ForecastWorkbench spot={spot} initialForecast={refreshed} now={elapsedDayNow} />);
    await waitFor(() => expect(briefRequests).toBe(2));

    expect(announced()).toBe(before);
  });

  it("treats a network failure as a failed outlook, not a published nothing", async () => {
    // The catch arm is the likelier trigger in a browser than a 503: offline,
    // DNS, TLS reset, dropped connection.
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) throw new TypeError("Failed to fetch");
      return jsonResponse(fixtureForecast());
    }));

    render(
      <ForecastWorkbench spot={spot} initialForecast={fixtureForecast()} now={elapsedDayNow} />
    );

    const line = await screen.findByText(/The daily outlook could not be loaded\./);
    expect(screen.queryByText(/No daylight recommendation for this day/)).toBeNull();
    // A transport failure has to be audible, not just visible.
    expect(line.getAttribute("role")).toBe("status");
  });

  it("keeps a rendered outlook when a later refresh drops the connection", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    let briefRequests = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/brief?")) {
        briefRequests += 1;
        if (briefRequests > 1) throw new TypeError("Failed to fetch");
        return jsonResponse({
          status: "model",
          brief: {
            provider: "google",
            headline: "A published outlook",
            setup: "Public inputs support the read.",
            revision: 1,
            generatedAt: "2026-08-02T07:05:00.000Z",
            picks: [],
            bustFactors: [],
            lesson: { topic: "Timing", text: "Windows close.", factRefs: ["wave:1"] }
          }
        });
      }
      return jsonResponse({}, 503);
    }));

    const first = fixtureForecast();
    const { rerender } = render(
      <ForecastWorkbench spot={spot} initialForecast={first} now={elapsedDayNow} />
    );
    await screen.findByRole("heading", { name: "A published outlook" });

    const refreshed = ForecastResponseSchema.parse({ ...first, generatedAt: "2026-08-02T08:00:00.000Z" });
    rerender(<ForecastWorkbench spot={spot} initialForecast={refreshed} now={elapsedDayNow} />);
    await waitFor(() => expect(briefRequests).toBe(2));

    // A dropped refresh must not evict what the reader is already reading.
    expect(screen.getByRole("heading", { name: "A published outlook" })).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it("says so on Analysis when the forecast request itself failed", async () => {
    window.history.replaceState({}, "", "/?spot=bolinas&tab=analysis");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse({ error: "unavailable" }, 503)));

    render(
      <ForecastWorkbench spot={spot} initialForecast={null} initialError="forecast failed" now={now} />
    );

    // The panel must not claim the sibling tab has data when it is showing an
    // error, and the state must be announced.
    const line = await screen.findByText(
      /Forecast data for this spot is temporarily unavailable, so there is no analysis to show yet\./
    );
    expect(line.getAttribute("role")).toBe("status");
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
