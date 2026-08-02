/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function fixtureForecast(): ForecastResponse {
  const fixture = buildFixtureForecast("bolinas");
  return ForecastResponseSchema.parse({
    ...fixture,
    spot,
    windows: fixture.windows.map((window) => ({ ...window, spotId: spot.id }))
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

  it("opens a query-string-selected spot returned by the API", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    installSuccessfulApi();

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Test Break" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Forecast workbench" })).toBeTruthy();
    expect(screen.getByRole("table", { name: /Three-hour surf-planning inputs/ })).toBeTruthy();
    expect(screen.getByText("Deterministic fallback")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Daily report/ }).getAttribute("href")).toBe("/");
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

  it("shares a recovered canonical workbench forecast with the hero", async () => {
    window.history.replaceState({}, "", "/?spot=test-break");
    const forecast = fixtureForecast();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/spots") return jsonResponse(spotsResponse);
      if (path === `/api/forecast/${spot.id}`) return jsonResponse({ error: "temporarily unavailable" }, 503);
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

    releaseRecovery();
    await waitFor(() => {
      expect(container.querySelector(".spotCall")?.textContent).toContain("modeled nearshore Hs");
      expect(container.querySelector(".spotCall")?.textContent).not.toContain("No reliable wave call yet");
    });
  });

  it("shows a visible error when the spot catalog API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => jsonResponse({ error: "unavailable" }, 503))
    );

    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("/api/spots returned 503");
  });
});
