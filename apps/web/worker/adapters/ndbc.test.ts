import { describe, expect, it } from "vitest";
import {
  buildNdbcRealtimeUrl,
  fetchNdbcRealtimeObservationsForStations,
  parseNdbcRealtimeText
} from "./ndbc";
import type { SourceFetch } from "./types";

const HEADER = `#YY  MM DD hh mm WDIR WSPD GST  WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
#yr  mo dy hr mn degT m/s  m/s  m    sec sec degT hPa  degC degC degC nmi hPa  ft`;

const FIXTURES: Record<string, string> = {
  "46237": `${HEADER}
2026 07 10 02 30 MM MM MM 1.7 9 5.4 291 MM 13.2 14.3 MM MM MM MM
2026 07 10 02 00 MM MM MM 1.6 15 5.3 239 MM 13.3 14.5 MM MM MM MM`,
  "46026": `${HEADER}
2026 07 10 02 30 320 10.0 12.0 MM MM MM MM 1012.6 MM 12.9 MM MM MM MM
2026 07 10 02 20 320 10.0 12.0 2.4 MM 6.0 300 1012.8 MM MM MM MM MM MM
2026 07 10 02 10 MM MM MM 2.4 8 6.0 300 MM MM 12.9 MM MM MM MM`,
  "46013": `\uFEFF#YY\tMM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE\r
#yr mo dy hr mn degT m/s m/s m sec sec degT hPa degC degC degC nmi hPa ft\r
2026 07 10 01 50 310 14.0 16.0 2.8 7 5.9 316 1011.8 12.4 MM 11.0 MM MM MM\r
2026 07 10 02 20 310 14.0 17.0 2.6 8 5.7 318 1011.6 12.4 MM 11.0 MM MM MM`,
  "46012": `${HEADER}
2026 07 10 02 00 310 9.0 11.0 2.5 9 MM MM 1014.6 13.1 12.9 12.0 MM -1.1 MM`
};

function stationIdFromUrl(url: string): string {
  const match = url.match(/\/([^/]+)\.txt$/);
  if (!match?.[1]) throw new Error(`unexpected NDBC URL ${url}`);
  return match[1];
}

describe("NDBC realtime observation adapter", () => {
  it("builds the official realtime2 standard meteorological URL", () => {
    expect(buildNdbcRealtimeUrl(" 46237 ")).toBe("https://www.ndbc.noaa.gov/data/realtime2/46237.txt");
  });

  it("fetches each unique NorCal reference station and selects its newest valid wave row", async () => {
    const requestedUrls: string[] = [];
    const fetcher: SourceFetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const stationId = stationIdFromUrl(url);
      const fixture = FIXTURES[stationId];
      if (!fixture) return new Response("not found", { status: 404 });
      return new Response(fixture, { headers: { "content-type": "text/plain" } });
    };

    const outcome = await fetchNdbcRealtimeObservationsForStations(
      ["46237", "46026", "46013", "46012", "46237", " 46026 "],
      {
        fetcher,
        now: new Date("2026-07-10T03:00:00Z")
      }
    );

    expect(outcome.status).toBe("success");
    expect(requestedUrls).toHaveLength(4);
    expect(new Set(requestedUrls).size).toBe(4);
    expect(outcome.metadata.stationIds).toEqual(["46012", "46013", "46026", "46237"]);
    expect(outcome.metadata.freshStationIds).toEqual(["46012", "46013", "46026", "46237"]);

    expect(outcome.rows.find((row) => row.stationId === "46237")).toEqual({
      stationId: "46237",
      observedAt: "2026-07-10T02:30:00.000Z",
      waveHeightM: 1.7,
      dominantPeriodS: 9,
      averagePeriodS: 5.4,
      meanWaveDirectionDeg: 291,
      waterTempC: 14.3
    });
    expect(outcome.rows.find((row) => row.stationId === "46026")).toMatchObject({
      observedAt: "2026-07-10T02:20:00.000Z",
      waveHeightM: 2.4,
      dominantPeriodS: null,
      averagePeriodS: 6,
      meanWaveDirectionDeg: 300,
      waterTempC: null
    });
    expect(outcome.rows.find((row) => row.stationId === "46013")).toMatchObject({
      observedAt: "2026-07-10T02:20:00.000Z",
      waveHeightM: 2.6,
      dominantPeriodS: 8,
      meanWaveDirectionDeg: 318
    });
    expect(outcome.rows.find((row) => row.stationId === "46012")).toMatchObject({
      averagePeriodS: null,
      meanWaveDirectionDeg: null,
      waterTempC: 12.9
    });
    expect(outcome.caveats.filter((caveat) => caveat.code === "ndbc_partial_observation")).toHaveLength(3);
  });

  it("parses two-digit years and ignores malformed or wind-only rows", () => {
    const row = parseNdbcRealtimeText(
      "46237",
      `${HEADER}
26 02 30 02 50 MM MM MM 9.9 10 6.0 280 MM MM 13.0 MM MM MM MM
26 07 10 02 50 MM MM MM MM MM MM MM MM MM 13.0 MM MM MM MM
26 07 10 02 40 MM MM MM 1.8 10 6.0 280 MM MM 13.0 MM MM MM MM`
    );

    expect(row).toMatchObject({
      stationId: "46237",
      observedAt: "2026-07-10T02:40:00.000Z",
      waveHeightM: 1.8
    });
  });

  it("retains a stale row for provenance but marks the adapter unhealthy", async () => {
    const fetcher: SourceFetch = async () => new Response(FIXTURES["46237"]);
    const outcome = await fetchNdbcRealtimeObservationsForStations(["46237"], {
      fetcher,
      now: new Date("2026-07-10T05:01:00Z"),
      staleAfterMinutes: 120
    });

    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.metadata.staleStationIds).toEqual(["46237"]);
    expect(outcome.caveats).toContainEqual(
      expect.objectContaining({ code: "ndbc_stale_observation" })
    );
  });

  it("does not fabricate a row when every wave height is MM", async () => {
    const fetcher: SourceFetch = async () =>
      new Response(`${HEADER}
2026 07 10 02 30 320 10 12 MM MM MM MM 1012 MM 12.9 MM MM MM MM`);
    const outcome = await fetchNdbcRealtimeObservationsForStations(["46026"], {
      fetcher,
      now: new Date("2026-07-10T03:00:00Z")
    });

    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.metadata.unavailableStationIds).toEqual(["46026"]);
    expect(outcome.caveats).toContainEqual(
      expect.objectContaining({ code: "ndbc_no_valid_wave_observation" })
    );
  });

  it("reports HTTP and transport failures without losing successful stations", async () => {
    const fetcher: SourceFetch = async (input) => {
      const stationId = stationIdFromUrl(String(input));
      if (stationId === "46026") throw new Error("connection reset");
      if (stationId === "46013") return new Response("unavailable", { status: 503 });
      return new Response(FIXTURES[stationId]);
    };
    const outcome = await fetchNdbcRealtimeObservationsForStations(["46237", "46026", "46013"], {
      fetcher,
      now: new Date("2026-07-10T03:00:00Z")
    });

    expect(outcome.status).toBe("partial");
    expect(outcome.rows.map((row) => row.stationId)).toEqual(["46237"]);
    expect(outcome.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("HTTP 503"), expect.stringContaining("connection reset")])
    );
  });
});
