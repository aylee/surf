import type { ForecastResponse, ForecastWindowInput, ScoredForecastWindow, SourceCapability, SpotId } from "@surf/contracts";
import { buildFixtureForecast, getSpotProfile, scoreSpotWindow } from "@surf/forecast-core";
import type { Env } from "./index";

type TideRow = {
  forecast_at: string;
  tide_ft_mllw: number;
  source_run_id: string | null;
};

type WindRow = {
  forecast_at: string;
  wind_speed_ms: number | null;
  wind_direction_deg: number | null;
  source_run_id: string | null;
};

type WaveRow = {
  forecast_at: string;
  nearshore_height_m: number | null;
  offshore_height_m: number | null;
  significant_height_m: number | null;
  peak_period_s: number | null;
  primary_direction_deg: number | null;
  source_run_id: string | null;
};

type SourceRunRow = {
  id: string;
  source_id: string;
  status: string;
  completed_at: string | null;
};

function asRows<T>(result: D1Result<T>): T[] {
  return Array.isArray(result.results) ? result.results : [];
}

async function queryRows<T>(db: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  const statement = db.prepare(sql);
  const bound = bindings.length > 0 ? statement.bind(...bindings) : statement;
  return asRows(await bound.all<T>());
}

function closestByTime<T>(rows: T[], forecastAt: string, timeOf: (row: T) => string, maxDistanceMs: number): T | null {
  const target = new Date(forecastAt).getTime();
  let best: { row: T; distance: number } | null = null;
  for (const row of rows) {
    const distance = Math.abs(new Date(timeOf(row)).getTime() - target);
    if (!Number.isFinite(distance) || distance > maxDistanceMs) continue;
    if (!best || distance < best.distance) best = { row, distance };
  }
  return best?.row ?? null;
}

function sourceFreshnessMinutes(sourceRuns: SourceRunRow[], now: Date): number {
  const completedTimes = sourceRuns.flatMap((run) => {
    if (!run.completed_at || run.status === "failure") return [];
    const time = new Date(run.completed_at).getTime();
    return Number.isFinite(time) ? [time] : [];
  });
  if (completedTimes.length === 0) return 24 * 60;
  return Math.max(0, Math.round((now.getTime() - Math.max(...completedTimes)) / 60000));
}

function metersToFeet(value: number | null): number | null {
  return value === null ? null : value * 3.28084;
}

function msToKt(value: number | null): number | null {
  return value === null ? null : value * 1.94384;
}

function sourceRunIds(...values: Array<string | null | undefined>): string[] {
  return values.filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
}

export async function buildForecastResponse(env: Env, spotId: SpotId, now = new Date()): Promise<ForecastResponse> {
  const fixture = buildFixtureForecast(spotId, now);
  if (typeof env.DB?.prepare !== "function") {
    return {
      ...fixture,
      sourceNote: "Fixture forecast. D1 binding is unavailable, so live source rows could not be read.",
      windows: fixture.windows.map((window) => ({
        ...window,
        caveats: [...window.caveats, "D1 binding unavailable; using fixture forecast."]
      }))
    };
  }

  try {
    const horizonEnd = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
    const [tideRows, windRows, waveRows, sourceRuns] = await Promise.all([
      queryRows<TideRow>(
        env.DB,
        `select forecast_at, tide_ft_mllw, source_run_id
         from tide_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
         order by forecast_at asc`,
        spotId,
        now.toISOString(),
        horizonEnd
      ),
      queryRows<WindRow>(
        env.DB,
        `select forecast_at, wind_speed_ms, wind_direction_deg, source_run_id
         from wind_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
         order by forecast_at asc`,
        spotId,
        now.toISOString(),
        horizonEnd
      ),
      queryRows<WaveRow>(
        env.DB,
        `select forecast_at, nearshore_height_m, offshore_height_m, significant_height_m,
                peak_period_s, primary_direction_deg, source_run_id
         from wave_forecasts
         where spot_id = ? and forecast_at >= ? and forecast_at <= ?
         order by forecast_at asc`,
        spotId,
        now.toISOString(),
        horizonEnd
      ),
      queryRows<SourceRunRow>(
        env.DB,
        `select id, source_id, status, completed_at
         from source_runs
         order by completed_at desc
         limit 10`
      )
    ]);

    const spot = getSpotProfile(spotId);
    const freshness = sourceFreshnessMinutes(sourceRuns, now);
    const windows: ScoredForecastWindow[] = fixture.windows.map((base) => {
      const tide = closestByTime(tideRows, base.forecastAt, (row) => row.forecast_at, 90 * 60 * 1000);
      const wind = closestByTime(windRows, base.forecastAt, (row) => row.forecast_at, 90 * 60 * 1000);
      const wave = closestByTime(waveRows, base.forecastAt, (row) => row.forecast_at, 90 * 60 * 1000);
      const waveHeightFt =
        metersToFeet(wave?.nearshore_height_m ?? null) ??
        metersToFeet(wave?.significant_height_m ?? null) ??
        metersToFeet(wave?.offshore_height_m ?? null) ??
        base.waveHeightFt;
      const activeCapabilities: SourceCapability[] = [];
      const caveats: string[] = [];

      if (wave) {
        activeCapabilities.push("forecast_wave_offshore");
      } else {
        caveats.push("NOAA GFSwave numeric GRIB extraction is unavailable for this window; using deterministic wave fallback.");
      }
      if (tide) activeCapabilities.push("tide");
      else caveats.push("CO-OPS tide row missing near this window.");
      if (wind) activeCapabilities.push("wind", "hazard");
      else caveats.push("NWS wind row missing near this window.");

      const input: ForecastWindowInput = {
        spotId,
        forecastAt: base.forecastAt,
        waveHeightFt: waveHeightFt ?? base.waveHeightFt ?? 0,
        peakPeriodSec: wave?.peak_period_s ?? base.peakPeriodSec ?? 0,
        primaryDirectionDeg: wave?.primary_direction_deg ?? base.primaryDirectionDeg ?? spot.bestSwellDeg.minDeg,
        tideFt: tide?.tide_ft_mllw ?? base.tideFt ?? spot.bestTideFt.min,
        windSpeedKt: msToKt(wind?.wind_speed_ms ?? null) ?? base.windSpeedKt ?? spot.maxOkWindKt,
        windDirectionDeg: wind?.wind_direction_deg ?? base.windDirectionDeg ?? spot.offshoreWindFromDeg.maxDeg,
        sourceFreshnessMinutes: freshness,
        activeCapabilities
      };
      const score = scoreSpotWindow(spot, input);

      return {
        ...score,
        waveHeightFt: input.waveHeightFt,
        peakPeriodSec: input.peakPeriodSec,
        primaryDirectionDeg: input.primaryDirectionDeg,
        tideFt: input.tideFt,
        windSpeedKt: input.windSpeedKt,
        windDirectionDeg: input.windDirectionDeg,
        sourceFreshnessMinutes: freshness,
        activeCapabilities,
        sourceRunIds: sourceRunIds(tide?.source_run_id, wind?.source_run_id, wave?.source_run_id),
        caveats
      };
    });

    return {
      spot,
      windows,
      generatedAt: now.toISOString(),
      sourceNote:
        tideRows.length > 0 || windRows.length > 0 || waveRows.length > 0
          ? "Forecast assembled from D1 source rows where available; missing layers lower confidence."
          : "No D1 source rows found for this spot; deterministic fallback values lower confidence."
    };
  } catch (error) {
    return {
      ...fixture,
      sourceNote: `Forecast fell back to fixtures because D1 read failed: ${error instanceof Error ? error.message : String(error)}`,
      windows: fixture.windows.map((window) => ({
        ...window,
        activeCapabilities: [],
        sourceRunIds: [],
        caveats: [...window.caveats, "D1 read failed; source confidence forced low."]
      }))
    };
  }
}
