import { useEffect, useMemo, useState } from "react";
import type {
  ForecastResponse,
  ReportResponse,
  ScoredForecastWindow,
  SourceCapability,
  SpotId,
  SpotProfile
} from "@surf/contracts";
import {
  AlertTriangle,
  Activity,
  Clock3,
  Database,
  FileText,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  Waves,
  Wind
} from "lucide-react";

type SourceMapSummary = {
  gfsWave?: {
    provider: string;
    sourceId: string;
    referencePoint?: {
      lat: number;
      lon: number;
    };
  };
  observedWave?: Array<{
    provider: string;
    stationId: string;
    name: string;
  }>;
  cdipMop?: {
    coverageStatus: string;
    dataAccessStatus: string;
    modelRegion: string;
    observedStationIds: string[];
    notes: string;
  };
  coopsTide?: {
    stationId: string;
    name: string;
    predictionVerified: boolean;
  };
  nwsPoint?: {
    capabilities: SourceCapability[];
    office: string;
    gridX: number;
    gridY: number;
    forecastZone: string;
  };
};

type ApiSpot = SpotProfile & {
  sourceMap?: SourceMapSummary;
};

type SpotsResponse = {
  spots: ApiSpot[];
  sourceNote: string;
};

type ForecastResult =
  | {
      status: "ready";
      data: ForecastResponse;
    }
  | {
      status: "error";
      error: string;
    };

type ReportResult =
  | {
      status: "ready";
      data: ReportResponse;
    }
  | {
      status: "error";
      error: string;
    };

type DashboardState = {
  loading: boolean;
  error: string | null;
  spots: ApiSpot[];
  sourceNote: string;
  forecasts: Partial<Record<SpotId, ForecastResult>>;
  report: ReportResult | null;
  fetchedAt: string | null;
};

type SpotSummary = {
  spot: ApiSpot;
  forecast: ForecastResult | undefined;
  windows: ScoredForecastWindow[];
  bestWindows: ScoredForecastWindow[];
  capabilities: SourceCapability[];
  caveats: string[];
  sourceRunIds: string[];
  freshestMinutes: number | null;
};

const initialState: DashboardState = {
  loading: true,
  error: null,
  spots: [],
  sourceNote: "",
  forecasts: {},
  report: null,
  fetchedAt: null
};

const capabilityLabels: Record<SourceCapability, string> = {
  forecast_wave_offshore: "GFSwave",
  forecast_wave_nearshore: "CDIP nearshore",
  observed_wave: "Observed wave",
  tide: "CO-OPS tide",
  wind: "NWS wind",
  hazard: "NWS hazard",
  bathymetry: "Bathymetry",
  quality_label: "Quality labels",
  comparison_forecast: "Comparison"
};

const qualityOrder: Record<string, number> = {
  excellent: 5,
  good: 4,
  fun: 3,
  fair: 2,
  poor: 1
};

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    signal
  });

  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }

  return (await response.json()) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}

function formatTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(new Date(value));
}

function formatFetchedAt(value: string | null): string {
  if (!value) return "Not loaded";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatFreshness(minutes: number | null): string {
  if (minutes === null) return "No source timestamp";
  if (minutes < 60) return `${Math.round(minutes)}m old`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h old`;
  return `${Math.round(minutes / (24 * 60))}d old`;
}

function formatNumber(value: number | null, suffix: string, digits = 1): string {
  if (value === null) return "n/a";
  return `${value.toFixed(digits)}${suffix}`;
}

function sourceStatusText(spot: ApiSpot): string {
  const map = spot.sourceMap;
  if (!map) return "Source map not returned";

  const gfs = map.gfsWave?.sourceId ?? "GFSwave pending";
  const tide = map.coopsTide ? `CO-OPS ${map.coopsTide.stationId}` : `CO-OPS ${spot.tideStation}`;
  const cdip = map.cdipMop
    ? `CDIP ${map.cdipMop.coverageStatus}, access ${map.cdipMop.dataAccessStatus}`
    : "CDIP status unknown";
  const nws = map.nwsPoint ? `NWS ${map.nwsPoint.forecastZone}` : "NWS point unknown";

  return `${gfs} · ${tide} · ${cdip} · ${nws}`;
}

function cdipNote(spot: ApiSpot): string | null {
  const cdip = spot.sourceMap?.cdipMop;
  if (!cdip) return null;
  return `${cdip.modelRegion.toUpperCase()} model: ${cdip.notes}`;
}

function sortByBestWindow(a: ScoredForecastWindow, b: ScoredForecastWindow): number {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;
  const confidenceDelta = b.confidence - a.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;
  return (qualityOrder[b.qualityLabel] ?? 0) - (qualityOrder[a.qualityLabel] ?? 0);
}

function buildSpotSummaries(
  spots: ApiSpot[],
  forecasts: DashboardState["forecasts"]
): SpotSummary[] {
  return spots.map((spot) => {
    const forecast = forecasts[spot.id];
    const windows = forecast?.status === "ready" ? forecast.data.windows : [];
    const bestWindows = [...windows].sort(sortByBestWindow).slice(0, 3);
    const capabilities = unique(windows.flatMap((window) => window.activeCapabilities));
    const caveats = unique([
      ...(forecast?.status === "ready" ? [forecast.data.sourceNote] : []),
      ...windows.flatMap((window) => window.caveats),
      ...(cdipNote(spot) ? [cdipNote(spot)!] : [])
    ]).filter(Boolean);
    const sourceRunIds = unique(windows.flatMap((window) => window.sourceRunIds));
    const freshnessValues = windows.map((window) => window.sourceFreshnessMinutes);
    const freshestMinutes = freshnessValues.length > 0 ? Math.min(...freshnessValues) : null;

    return {
      spot,
      forecast,
      windows,
      bestWindows,
      capabilities,
      caveats,
      sourceRunIds,
      freshestMinutes
    };
  });
}

function MetricTile({
  icon: Icon,
  label,
  value,
  tone = "neutral"
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
}) {
  return (
    <div className={`metricTile ${tone}`}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function CapabilityChips({ capabilities }: { capabilities: SourceCapability[] }) {
  if (capabilities.length === 0) {
    return <span className="emptyText">No active capabilities returned</span>;
  }

  return (
    <div className="chipRow">
      {capabilities.map((capability) => (
        <span key={capability} className="chip">
          {capabilityLabels[capability]}
        </span>
      ))}
    </div>
  );
}

function WindowConditions({ window }: { window: ScoredForecastWindow }) {
  return (
    <div className="conditionGrid" aria-label="Forecast conditions">
      <span>{formatNumber(window.waveHeightFt, " ft")}</span>
      <span>{formatNumber(window.peakPeriodSec, "s", 0)}</span>
      <span>{formatNumber(window.primaryDirectionDeg, "°", 0)}</span>
      <span>{formatNumber(window.tideFt, " ft")}</span>
      <span>{formatNumber(window.windSpeedKt, " kt", 0)}</span>
    </div>
  );
}

function BestWindowsTable({ summaries }: { summaries: SpotSummary[] }) {
  const bestWindows = summaries
    .flatMap((summary) =>
      summary.bestWindows.map((window) => ({
        spot: summary.spot,
        window
      }))
    )
    .sort((a, b) => sortByBestWindow(a.window, b.window))
    .slice(0, 12);

  if (bestWindows.length === 0) {
    return (
      <section className="tablePanel" aria-labelledby="best-windows-heading">
        <div className="sectionHeader">
          <div>
            <p className="eyebrow">72h scan</p>
            <h2 id="best-windows-heading">Best Windows</h2>
          </div>
        </div>
        <div className="emptyPanel">
          <AlertTriangle size={20} aria-hidden="true" />
          <span>No forecast windows returned yet.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="tablePanel" aria-labelledby="best-windows-heading">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">72h scan</p>
          <h2 id="best-windows-heading">Best Windows</h2>
        </div>
        <span className="subtleText">{bestWindows.length} windows ranked by score</span>
      </div>

      <div className="windowTable" role="table" aria-label="Best forecast windows in the next 72 hours">
        <div className="windowTableHeader" role="row">
          <span role="columnheader">Spot</span>
          <span role="columnheader">Time</span>
          <span role="columnheader">Score</span>
          <span role="columnheader">Conditions</span>
          <span role="columnheader">Sources</span>
        </div>
        {bestWindows.map(({ spot, window }) => (
          <div key={`${spot.id}-${window.forecastAt}`} className="windowTableRow" role="row">
            <div role="cell">
              <strong>{spot.name}</strong>
              <span>{window.qualityLabel}</span>
            </div>
            <div role="cell">{formatTime(window.forecastAt, spot.timezone)}</div>
            <div role="cell" className="scoreCell">
              <strong>{window.score}</strong>
              <span>{window.confidence}% conf</span>
            </div>
            <div role="cell">
              <WindowConditions window={window} />
            </div>
            <div role="cell">
              <span className="freshness">{formatFreshness(window.sourceFreshnessMinutes)}</span>
              <CapabilityChips capabilities={window.activeCapabilities} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReportPanel({ report }: { report: ReportResult | null }) {
  return (
    <section className="reportPanel" aria-labelledby="report-heading">
      <div className="sectionHeader">
        <div>
          <p className="eyebrow">report agent</p>
          <h2 id="report-heading">Daily Report</h2>
        </div>
        <FileText size={20} aria-hidden="true" />
      </div>

      {!report && <p className="bodyText">Report status has not loaded.</p>}

      {report?.status === "error" && (
        <div className="callout warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{report.error}</span>
        </div>
      )}

      {report?.status === "ready" && (
        <>
          <div className={`reportStatus ${report.data.enabled ? "enabled" : "disabled"}`}>
            <ShieldAlert size={18} aria-hidden="true" />
            <strong>{report.data.enabled ? "Enabled" : "Disabled"}</strong>
          </div>
          <p className="bodyText">
            {report.data.reason ??
              `Generated ${report.data.generatedAt ? formatFetchedAt(report.data.generatedAt) : "without timestamp"}.`}
          </p>
          {report.data.caveats && report.data.caveats.length > 0 && (
            <ul className="compactList">
              {report.data.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SpotCard({ summary }: { summary: SpotSummary }) {
  const { spot, forecast, bestWindows, capabilities, caveats, sourceRunIds, freshestMinutes } = summary;
  const topWindow = bestWindows[0];

  return (
    <article className="spotCard">
      <div className="spotHeader">
        <div>
          <p className="eyebrow">{spot.id}</p>
          <h3>{spot.name}</h3>
        </div>
        {topWindow ? (
          <div className={`qualityBadge ${topWindow.qualityLabel}`}>
            <strong>{topWindow.score}</strong>
            <span>{topWindow.qualityLabel}</span>
          </div>
        ) : (
          <div className="qualityBadge unknown">
            <strong>--</strong>
            <span>pending</span>
          </div>
        )}
      </div>

      <div className="sourceLine">
        <RadioTower size={16} aria-hidden="true" />
        <span>{sourceStatusText(spot)}</span>
      </div>

      {forecast?.status === "error" && (
        <div className="callout warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{forecast.error}</span>
        </div>
      )}

      {forecast?.status === "ready" && (
        <>
          <div className="spotMetaGrid">
            <div>
              <span>Source freshness</span>
              <strong>{formatFreshness(freshestMinutes)}</strong>
            </div>
            <div>
              <span>Source runs</span>
              <strong>{sourceRunIds.length > 0 ? sourceRunIds.length : "none"}</strong>
            </div>
            <div>
              <span>Reference buoys</span>
              <strong>{spot.referenceBuoys.join(", ")}</strong>
            </div>
            <div>
              <span>Tide station</span>
              <strong>{spot.tideStation}</strong>
            </div>
          </div>

          <div className="spotBlock">
            <h4>Active Capabilities</h4>
            <CapabilityChips capabilities={capabilities} />
          </div>

          <div className="spotBlock">
            <h4>Top Windows</h4>
            {bestWindows.length > 0 ? (
              <div className="miniWindowList">
                {bestWindows.map((window) => (
                  <div key={window.forecastAt} className="miniWindow">
                    <div>
                      <strong>{formatTime(window.forecastAt, spot.timezone)}</strong>
                      <span>{window.confidence}% confidence</span>
                    </div>
                    <WindowConditions window={window} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="emptyText">No 72h windows returned.</p>
            )}
          </div>

          <div className="spotBlock">
            <h4>Caveats</h4>
            {caveats.length > 0 ? (
              <ul className="caveatList">
                {caveats.slice(0, 5).map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            ) : (
              <p className="emptyText">No caveats returned.</p>
            )}
          </div>
        </>
      )}
    </article>
  );
}

export function App() {
  const [state, setState] = useState<DashboardState>(initialState);

  async function loadDashboard(signal: AbortSignal) {
    setState((current) => ({
      ...current,
      loading: true,
      error: null
    }));

    try {
      const [spotsPayload, reportPayload] = await Promise.all([
        fetchJson<SpotsResponse>("/api/spots", signal),
        fetchJson<ReportResponse>("/api/reports/today", signal)
          .then<ReportResult>((data) => ({ status: "ready", data }))
          .catch<ReportResult>((error) => ({ status: "error", error: errorMessage(error) }))
      ]);

      const forecastEntries = await Promise.all(
        spotsPayload.spots.map(async (spot) => {
          try {
            const data = await fetchJson<ForecastResponse>(`/api/forecast/${spot.id}`, signal);
            return [spot.id, { status: "ready", data } satisfies ForecastResult] as const;
          } catch (error) {
            return [spot.id, { status: "error", error: errorMessage(error) } satisfies ForecastResult] as const;
          }
        })
      );

      if (signal.aborted) return;

      setState({
        loading: false,
        error: null,
        spots: spotsPayload.spots,
        sourceNote: spotsPayload.sourceNote,
        forecasts: Object.fromEntries(forecastEntries) as Partial<Record<SpotId, ForecastResult>>,
        report: reportPayload,
        fetchedAt: new Date().toISOString()
      });
    } catch (error) {
      if (signal.aborted) return;

      setState((current) => ({
        ...current,
        loading: false,
        error: errorMessage(error),
        fetchedAt: new Date().toISOString()
      }));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard(controller.signal);
    return () => controller.abort();
  }, []);

  const summaries = useMemo(() => buildSpotSummaries(state.spots, state.forecasts), [state.spots, state.forecasts]);
  const allCapabilities = unique(summaries.flatMap((summary) => summary.capabilities));
  const loadedForecasts = summaries.filter((summary) => summary.forecast?.status === "ready").length;
  const freshest = summaries
    .map((summary) => summary.freshestMinutes)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)[0];
  const allCaveats = unique(summaries.flatMap((summary) => summary.caveats));

  function handleRefresh() {
    const controller = new AbortController();
    void loadDashboard(controller.signal);
  }

  const showInitialLoading = state.loading && state.spots.length === 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">public-data surf engine</p>
          <h1>NorCal Forecast Console</h1>
        </div>
        <button className="iconButton" type="button" onClick={handleRefresh} disabled={state.loading}>
          <RefreshCw size={18} aria-hidden="true" />
          <span>{state.loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>

      {state.error && (
        <div className="callout danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{state.error}</span>
        </div>
      )}

      <section className="metricBand" aria-label="Dashboard status">
        <MetricTile icon={Waves} label="V1 spots" value={`${state.spots.length || 0}/6`} tone={state.spots.length === 6 ? "good" : "warn"} />
        <MetricTile icon={Database} label="Forecasts" value={`${loadedForecasts}/${state.spots.length || 6}`} tone={loadedForecasts === state.spots.length && loadedForecasts > 0 ? "good" : "warn"} />
        <MetricTile icon={Clock3} label="Freshest source" value={formatFreshness(freshest ?? null)} tone={freshest !== undefined && freshest < 6 * 60 ? "good" : "warn"} />
        <MetricTile
          icon={Activity}
          label="Capabilities"
          value={allCapabilities.length > 0 ? `${allCapabilities.length} active` : "none active"}
          tone={allCapabilities.length > 0 ? "good" : "warn"}
        />
      </section>

      {state.sourceNote && (
        <div className="sourceNote">
          <RadioTower size={17} aria-hidden="true" />
          <span>{state.sourceNote}</span>
          <span>Fetched {formatFetchedAt(state.fetchedAt)}</span>
        </div>
      )}

      {showInitialLoading ? (
        <section className="loadingPanel" aria-live="polite">
          <RefreshCw size={22} aria-hidden="true" />
          <span>Loading live API data...</span>
        </section>
      ) : (
        <>
          <div className="consoleGrid">
            <BestWindowsTable summaries={summaries} />
            <div className="sideStack">
              <ReportPanel report={state.report} />
              <section className="capabilityPanel" aria-labelledby="capabilities-heading">
                <div className="sectionHeader">
                  <div>
                    <p className="eyebrow">source posture</p>
                    <h2 id="capabilities-heading">Active Capabilities</h2>
                  </div>
                  <Wind size={20} aria-hidden="true" />
                </div>
                <CapabilityChips capabilities={allCapabilities} />
                {allCaveats.length > 0 && (
                  <ul className="compactList">
                    {allCaveats.slice(0, 5).map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>

          <section className="spotGrid" aria-label="V1 NorCal spots">
            {summaries.map((summary) => (
              <SpotCard key={summary.spot.id} summary={summary} />
            ))}
          </section>
        </>
      )}
    </main>
  );
}
