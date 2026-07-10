import { getSpotProfile, NORCAL_SPOTS } from "@surf/forecast-core";
import { describe, expect, it } from "vitest";
import {
  CDIP_MOP_SOURCE_ID,
  fetchCdipMopForecastsForSpots,
  parseCdipMopAscii
} from "./cdip-mop";
import type { SourceFetch } from "./types";

function asciiFixture(overrides: Partial<Record<"waveTime" | "waveHs" | "waveTp" | "waveDp" | "waveDm", string>> = {}) {
  const values = {
    waveTime: "1783652400, 1783663200",
    waveHs: "1.2, 1.5",
    waveTp: "15.384616, 9.871668",
    waveDp: "294.3, 299.1",
    waveDm: "-999.99, 285.0",
    ...overrides
  };
  const length = (value: string) => value.split(",").length;
  return `Dataset {
    Int32 waveTime[waveTime = ${length(values.waveTime)}];
    Float32 waveHs[waveTime = ${length(values.waveHs)}];
    Float32 waveTp[waveTime = ${length(values.waveTp)}];
    Float32 waveDp[waveTime = ${length(values.waveDp)}];
    Float32 waveDm[waveTime = ${length(values.waveDm)}];
} cdip/model/MOP_alongshore/fixture_forecast.nc;
---------------------------------------------
waveTime[${length(values.waveTime)}]
${values.waveTime}

waveHs[${length(values.waveHs)}]
${values.waveHs}

waveTp[${length(values.waveTp)}]
${values.waveTp}

waveDp[${length(values.waveDp)}]
${values.waveDp}

waveDm[${length(values.waveDm)}]
${values.waveDm}
`;
}

function dasFixture(cycle = "202607100000") {
  return `Attributes {
    NC_GLOBAL {
      String history "2026-07-10T01:55:58Z: dataset created; Net_model version 2.1. Runtime arguments: /project/f90_bin/net_model_gf -s ${cycle} -h 240 -g 3 -c norcal_alongshore_ref.nc -i WW3_forecast.INPUT -z forecast -e -b fc_full -S";
      String date_modified "2026-07-10T01:55:58Z";
    }
  }`;
}

function successfulFetcher(text = asciiFixture()): SourceFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "HEAD") {
      return new Response(null, {
        headers: { "Last-Modified": "Fri, 10 Jul 2026 01:55:58 GMT" }
      });
    }
    if (String(input).endsWith(".das")) return new Response(dasFixture());
    return new Response(text, { headers: { "Content-Type": "text/plain" } });
  }) as SourceFetch;
}

describe("CDIP MOP forecast adapter", () => {
  it("locks the five verified public point mappings and leaves Bolinas unmapped", () => {
    expect(
      Object.fromEntries(
        NORCAL_SPOTS.map((spot) => [
          spot.id,
          spot.sourceMap.cdipMop.modelPoint
            ? {
                point: spot.sourceMap.cdipMop.modelPoint.id,
                depth: spot.sourceMap.cdipMop.modelPoint.waterDepthM,
                scale: spot.sourceMap.cdipMop.modelPoint.nearshoreHeightScale,
                relationship: spot.sourceMap.cdipMop.modelPoint.relationship
              }
            : null
        ])
      )
    ).toEqual({
      "obsf-north": { point: "SF043", depth: 10, scale: 1, relationship: "direct_nearshore_point" },
      "obsf-central": { point: "SF029", depth: 10.01, scale: 1, relationship: "direct_nearshore_point" },
      "obsf-south": { point: "SF015", depth: 10.01, scale: 1, relationship: "direct_nearshore_point" },
      "linda-mar": { point: "SM371", depth: 15.01, scale: 0.6, relationship: "outside_cove_approach_proxy" },
      stinson: { point: "MA122", depth: 15, scale: 1, relationship: "direct_nearshore_point" },
      bolinas: null
    });
    expect(getSpotProfile("bolinas").sourceMap.cdipMop.coverageStatus).toBe("absent");
  });

  it("parses only the five bulk arrays and turns the documented fill value into null", () => {
    expect(parseCdipMopAscii(asciiFixture())).toEqual({
      declaredRowCount: 2,
      skippedRowCount: 0,
      missingMeanDirectionCount: 1,
      samples: [
        {
          epochSeconds: 1783652400,
          significantHeightM: 1.2,
          peakPeriodS: 15.384616,
          peakDirectionDeg: 294.3,
          meanDirectionDeg: null
        },
        {
          epochSeconds: 1783663200,
          significantHeightM: 1.5,
          peakPeriodS: 9.871668,
          peakDirectionDeg: 299.1,
          meanDirectionDeg: 285
        }
      ]
    });
  });

  it("preserves HTTP Last-Modified as source update and applies only Linda Mar's explicit cove scale", async () => {
    const outcome = await fetchCdipMopForecastsForSpots(
      [getSpotProfile("obsf-north"), getSpotProfile("linda-mar"), getSpotProfile("bolinas")],
      {
        fetcher: successfulFetcher(),
        now: new Date("2026-07-10T02:00:00Z"),
        horizonHours: 6
      }
    );

    expect(outcome.status).toBe("success");
    expect(outcome.sourceId).toBe(CDIP_MOP_SOURCE_ID);
    expect(outcome.rows).toHaveLength(4);
    expect(outcome.rows.find((row) => row.spotId === "obsf-north")).toMatchObject({
      modelPointId: "SF043",
      sourceUpdatedAt: "2026-07-10T01:55:58.000Z",
      sourceTimestampSemantics: "http_last_modified_source_update_not_model_cycle",
      modelCycleAt: "2026-07-10T00:00:00.000Z",
      leadHour: 3,
      significantHeightM: 1.2,
      nearshoreHeightM: 1.2,
      nearshoreHeightScale: 1,
      heightSemantics: "modeled_significant_wave_height_not_breaking_face_height"
    });
    expect(outcome.rows.find((row) => row.spotId === "linda-mar")).toMatchObject({
      modelPointId: "SM371",
      significantHeightM: 1.2,
      nearshoreHeightM: 0.72,
      nearshoreHeightScale: 0.6,
      pointRelationship: "outside_cove_approach_proxy"
    });
    expect(outcome.metadata.unavailableSpotIds).toEqual(["bolinas"]);
    expect(outcome.caveats).toContainEqual(expect.objectContaining({ code: "cdip_mop_linda_mar_cove_scale" }));
    expect(outcome.caveats).toContainEqual(expect.objectContaining({ code: "cdip_mop_bolinas_unmapped" }));
  });

  it("rejects shape drift instead of misaligning the bulk arrays", () => {
    expect(() => parseCdipMopAscii(asciiFixture({ waveHs: "1.2" }))).toThrow(
      "bulk arrays declared different lengths"
    );
  });

  it("parses the true runtime cycle from the bounded DAS history metadata", async () => {
    const outcome = await fetchCdipMopForecastsForSpots([getSpotProfile("stinson")], {
      fetcher: successfulFetcher(),
      now: new Date("2026-07-10T02:00:00Z"),
      horizonHours: 6
    });
    expect(outcome.metadata.modelCycleAtBySpot).toEqual({
      stinson: "2026-07-10T00:00:00.000Z"
    });
    expect(outcome.rows.map((row) => row.leadHour)).toEqual([3, 6]);
  });

  it("fails closed when DAS history omits or ambiguously repeats the runtime cycle", async () => {
    const fetcher: SourceFetch = async (input, init) => {
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "Last-Modified": "Fri, 10 Jul 2026 01:55:58 GMT" } });
      }
      if (String(input).endsWith(".das")) {
        return new Response(
          'Attributes { NC_GLOBAL { String history "Runtime arguments: model -h 240"; } }'
        );
      }
      return new Response(asciiFixture());
    };
    const outcome = await fetchCdipMopForecastsForSpots([getSpotProfile("stinson")], {
      fetcher,
      now: new Date("2026-07-10T02:00:00Z"),
      horizonHours: 6
    });
    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.errors.join(" ")).toContain("exactly one runtime -s");
  });

  it("reports an upstream failure without manufacturing fallback rows", async () => {
    const fetcher: SourceFetch = async () => new Response("unavailable", { status: 503 });
    const outcome = await fetchCdipMopForecastsForSpots([getSpotProfile("stinson")], {
      fetcher,
      now: new Date("2026-07-10T02:00:00Z"),
      horizonHours: 6
    });
    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.errors.join(" ")).toContain("HTTP 503");
  });

  it("fails closed when source update metadata is absent", async () => {
    const fetcher: SourceFetch = async (input) =>
      new Response(String(input).endsWith(".das") ? dasFixture() : asciiFixture());
    const outcome = await fetchCdipMopForecastsForSpots([getSpotProfile("stinson")], {
      fetcher,
      now: new Date("2026-07-10T02:00:00Z"),
      horizonHours: 6
    });
    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.caveats).toContainEqual(expect.objectContaining({ code: "cdip_mop_source_update_missing" }));
  });

  it("bounds constrained ASCII payloads before buffering them", async () => {
    const fetcher: SourceFetch = async () =>
      new Response(asciiFixture(), {
        headers: {
          "Content-Length": String(64 * 1024 + 1),
          "Last-Modified": "Fri, 10 Jul 2026 01:55:58 GMT"
        }
      });
    const outcome = await fetchCdipMopForecastsForSpots([getSpotProfile("stinson")], {
      fetcher,
      now: new Date("2026-07-10T02:00:00Z"),
      horizonHours: 6
    });
    expect(outcome.status).toBe("failure");
    expect(outcome.rows).toEqual([]);
    expect(outcome.errors.join(" ")).toContain("exceeded 65536 bytes");
  });
});
