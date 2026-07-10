import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ForecastResponse,
  ScoredForecastWindow,
  SourceCapability,
  SpotId,
  SpotProfile
} from "@surf/contracts";
import {
  ArrowLeft,
  AlertTriangle,
  ChevronRight,
  Clock3,
  Database,
  Info,
  RefreshCw,
  Radio,
  Waves
} from "lucide-react";
import {
  availableLocalDateKeys,
  calmestWindow,
  cardinalDirection,
  confidenceLabel,
  earliestAvailableLocalDateKey,
  formatClock,
  formatDay,
  formatWindowSpan,
  isPlanningWindow,
  localDateParts,
  surfaceCondition,
  surfHeightRange,
  windRelation,
  type SurfaceCondition
} from "./forecast-view";

type SourceMapSummary = {
  nwsWaveGrid?: {
    provider: string;
    forecastGridData: string;
    breakingHeightScale: number;
    notes: string;
  };
  observedWave?: Array<{
    provider: string;
    stationId: string;
    name: string;
  }>;
  coopsTide?: {
    stationId: string;
    name: string;
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
  | { status: "ready"; data: ForecastResponse }
  | { status: "error"; error: string };

type DashboardState = {
  loading: boolean;
  error: string | null;
  spots: ApiSpot[];
  forecasts: Partial<Record<SpotId, ForecastResult>>;
  fetchedAt: string | null;
};

type SpotSummary = {
  spot: ApiSpot;
  forecast: ForecastResult | undefined;
  windows: ScoredForecastWindow[];
};

type DailySpotRow = SpotSummary & {
  window: ScoredForecastWindow | undefined;
};

const initialState: DashboardState = {
  loading: true,
  error: null,
  spots: [],
  forecasts: {},
  fetchedAt: null
};

const spotIds = new Set<SpotId>([
  "obsf-north",
  "obsf-central",
  "obsf-south",
  "linda-mar",
  "stinson",
  "bolinas"
]);

const surfaceRank: Record<SurfaceCondition, number> = {
  clean: 3,
  fair: 2,
  choppy: 1,
  unknown: 0
};

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}

function formatNumber(value: number | null, suffix: string, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}${suffix}`;
}

function formatFreshness(minutes: number | null): string {
  if (minutes === null) return "Freshness unavailable";
  if (minutes < 60) return `Updated ${Math.max(1, Math.round(minutes))}m ago`;
  if (minutes < 24 * 60) return `Updated ${Math.round(minutes / 60)}h ago`;
  return `Updated ${Math.round(minutes / (24 * 60))}d ago`;
}

function formatFetchedAt(value: string | null): string {
  if (!value) return "Not updated";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function activeSpotId(): SpotId | null {
  const value = new URLSearchParams(window.location.search).get("spot") as SpotId | null;
  return value && spotIds.has(value) ? value : null;
}

function forecastHref(spotId: SpotId): string {
  return `/?spot=${encodeURIComponent(spotId)}`;
}

function sortDailyRows(left: DailySpotRow, right: DailySpotRow): number {
  if (!left.window && !right.window) return 0;
  if (!left.window) return 1;
  if (!right.window) return -1;
  const surfaceDelta =
    surfaceRank[surfaceCondition(right.spot, right.window)] -
    surfaceRank[surfaceCondition(left.spot, left.window)];
  if (surfaceDelta !== 0) return surfaceDelta;
  if (right.window.score !== left.window.score) return right.window.score - left.window.score;
  if (right.window.confidence !== left.window.confidence) {
    return right.window.confidence - left.window.confidence;
  }
  return left.window.forecastAt.localeCompare(right.window.forecastAt);
}

function tideTrend(windows: ScoredForecastWindow[], selected: ScoredForecastWindow): string {
  if (selected.tideTrend) {
    return selected.tideTrend[0]!.toUpperCase() + selected.tideTrend.slice(1);
  }
  if (selected.tideFt === null) return "Trend unavailable";
  const sorted = [...windows].sort((left, right) => left.forecastAt.localeCompare(right.forecastAt));
  const index = sorted.findIndex((window) => window.forecastAt === selected.forecastAt);
  const comparison = sorted[index + 1]?.tideFt ?? sorted[index - 1]?.tideFt ?? null;
  if (comparison === null) return "Trend unavailable";
  const difference = index + 1 < sorted.length ? comparison - selected.tideFt : selected.tideFt - comparison;
  if (Math.abs(difference) < 0.15) return "Steady";
  return difference > 0 ? "Rising" : "Falling";
}

function closestWindow(windows: ScoredForecastWindow[], now: Date): ScoredForecastWindow | undefined {
  return windows
    .filter((window) => window.ratingStatus === "scored")
    .sort(
      (left, right) =>
        Math.abs(new Date(left.forecastAt).getTime() - now.getTime()) -
        Math.abs(new Date(right.forecastAt).getTime() - now.getTime())
    )[0];
}

function windowConditionText(spot: ApiSpot, window: ScoredForecastWindow): string {
  const surface = surfaceCondition(spot, window);
  if (window.ratingStatus !== "scored") return "No reliable surf call";
  if (surface === "unknown") return "Wind unavailable";
  if (surface === "fair") return "Fair surface";
  return surface[0]!.toUpperCase() + surface.slice(1);
}

function primarySwellText(window: ScoredForecastWindow): string {
  const swell = window.primarySwell;
  if (!swell || swell.heightFt === null || swell.periodSec === null) return "Swell unavailable";
  return `${swell.heightFt.toFixed(1)} ft @ ${swell.periodSec.toFixed(0)}s ${cardinalDirection(swell.directionDeg)}`;
}

function isCdipMop(window: ScoredForecastWindow): boolean {
  return window.waveProvenance?.sourceId === "cdip:mop-forecast";
}

function regionalReport(rows: DailySpotRow[], dateKey: string | null): { title: string; body: string } {
  const ready = rows.filter((row): row is DailySpotRow & { window: ScoredForecastWindow } => Boolean(row.window));
  if (ready.length === 0 || !dateKey) {
    return {
      title: "No reliable regional call yet",
      body: "Wave data is unavailable or incomplete. Wind and tide context remain visible inside each spot."
    };
  }

  const top = ready[0]!;
  const cleanSpotCount = ready.filter((row) => surfaceCondition(row.spot, row.window) === "clean").length;
  const heights = ready.map((row) => row.window.waveHeightFt).filter((value): value is number => value !== null);
  const smallest = [...ready].sort((left, right) => (left.window.waveHeightFt ?? 999) - (right.window.waveHeightFt ?? 999))[0]!;
  const largest = [...ready].sort((left, right) => (right.window.waveHeightFt ?? -1) - (left.window.waveHeightFt ?? -1))[0]!;
  const day = formatDay(top.window.forecastAt, top.spot.timezone);
  const title = cleanSpotCount > 0
    ? `${day}: clean at ${cleanSpotCount} spot${cleanSpotCount === 1 ? "" : "s"}`
    : `${day}: mostly wind-affected`;

  const sizeStory =
    heights.length > 0
      ? `${smallest.spot.name} is smallest at ${surfHeightRange(smallest.window.waveHeightFt)}; ${largest.spot.name} carries the most size at ${surfHeightRange(largest.window.waveHeightFt)}.`
      : "Modeled size is not available.";
  return {
    title,
    body: `The calmest surface forecast is ${top.spot.name} around ${formatWindowSpan(top.window.forecastAt, top.spot.timezone)}. ${sizeStory}`
  };
}

function ConditionPill({ spot, window }: { spot: ApiSpot; window: ScoredForecastWindow }) {
  const surface = window.ratingStatus === "scored" ? surfaceCondition(spot, window) : "unknown";
  return <span className={`conditionPill ${surface}`}>{windowConditionText(spot, window)}</span>;
}

function activeHazardMessages(windows: Array<ScoredForecastWindow | undefined>): string[] {
  return unique(
    windows.flatMap((window) =>
      window?.activeCapabilities.includes("hazard")
        ? window.caveats.filter((caveat) => caveat.startsWith("Active NWS hazard:"))
        : []
    )
  );
}

function HazardNotice({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <aside className="hazardNotice" aria-label="Active National Weather Service hazard">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        <strong>Active NWS hazard</strong>
        {messages.map((message) => (
          <span key={message}>{message.replace(/^Active NWS hazard:\s*/, "")}</span>
        ))}
      </div>
    </aside>
  );
}

function Header({ state, onRefresh }: { state: DashboardState; onRefresh: () => void }) {
  const sourceAges = Object.values(state.forecasts).flatMap((forecast) =>
    forecast?.status === "ready" ? forecast.data.windows.map((window) => window.sourceFreshnessMinutes) : []
  );
  const freshest = sourceAges.length > 0 ? Math.min(...sourceAges) : null;

  return (
    <header className="appHeader">
      <a className="wordmark" href="/" aria-label="Surf daily report home">
        <span className="wordmarkMark" aria-hidden="true">≈</span>
        <span>surf</span>
      </a>
      <div className="headerActions">
        <span className="updateLabel" title={state.fetchedAt ? `Fetched ${formatFetchedAt(state.fetchedAt)}` : undefined}>
          <Clock3 size={15} aria-hidden="true" />
          {formatFreshness(freshest)}
        </span>
        <button className="refreshButton" type="button" onClick={onRefresh} disabled={state.loading}>
          <RefreshCw className={state.loading ? "spin" : undefined} size={17} aria-hidden="true" />
          <span className="refreshText">{state.loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </div>
    </header>
  );
}

function DailyReport({ summaries, now }: { summaries: SpotSummary[]; now: Date }) {
  const reportDateKey = earliestAvailableLocalDateKey(summaries, now);
  const rows = summaries
    .map((summary) => ({
      ...summary,
      window: reportDateKey ? calmestWindow(summary.spot, summary.windows, now, reportDateKey) : undefined
    }))
    .sort(sortDailyRows);
  const report = regionalReport(rows, reportDateKey);
  const topRows = rows.filter((row) => row.window).slice(0, 3);
  const sourceUpdates = unique(
    rows.flatMap((row) => (row.window?.waveProvenance ? [row.window.waveProvenance.sourceUpdatedAt] : []))
  );
  const hazards = activeHazardMessages(rows.map((row) => row.window));

  return (
    <>
      <section className="reportHero" aria-labelledby="daily-report-title">
        <p className="kicker">NorCal daily surf report</p>
        <h1 id="daily-report-title">{report.title}</h1>
        <p className="reportLead">{report.body}</p>
        {topRows.length > 0 && (
          <div className="shortlist" aria-label="Quick spot shortlist">
            {topRows.map((row) => (
              <a className="shortlistItem" href={forecastHref(row.spot.id)} key={row.spot.id}>
                <span>
                  <strong>{row.spot.name}</strong>
                  <small>{formatWindowSpan(row.window!.forecastAt, row.spot.timezone)}</small>
                </span>
                <span className="shortlistSize">{surfHeightRange(row.window!.waveHeightFt)}</span>
                <ChevronRight size={17} aria-hidden="true" />
              </a>
            ))}
          </div>
        )}
      </section>

      <HazardNotice messages={hazards} />

      <section className="compareSection" aria-labelledby="compare-heading">
        <div className="sectionTitle">
          <div>
            <p className="kicker">6am–6pm</p>
            <h2 id="compare-heading">Compare spots</h2>
          </div>
          {rows[0]?.window && <span>{formatDay(rows[0].window.forecastAt, rows[0].spot.timezone)}</span>}
        </div>
        <div className="compareList">
          <div className="compareHeader" aria-hidden="true">
            <span>Spot</span>
            <span>Calmest window</span>
            <span>Size estimate</span>
            <span>Wind / surface</span>
            <span>Tide</span>
            <span />
          </div>
          {rows.map((row) => (
            <a className="compareRow" href={forecastHref(row.spot.id)} key={row.spot.id}>
              <span className="spotNameCell">
                <strong>{row.spot.name}</strong>
                {row.window ? <ConditionPill spot={row.spot} window={row.window} /> : <span className="conditionPill unknown">No call</span>}
              </span>
              {row.window ? (
                <>
                  <span data-label="Calmest window">{formatWindowSpan(row.window.forecastAt, row.spot.timezone)}</span>
                  <strong data-label="Size estimate">{surfHeightRange(row.window.waveHeightFt)}</strong>
                  <span data-label="Wind / surface">
                    {windRelation(row.spot, row.window)} · {cardinalDirection(row.window.windDirectionDeg)} {formatNumber(row.window.windSpeedKt, " kt")}
                  </span>
                  <span data-label="Tide">{formatNumber(row.window.tideFt, " ft", 1)} · {tideTrend(row.windows, row.window).toLowerCase()}</span>
                </>
              ) : (
                <span className="noCallRow">
                  {row.forecast?.status === "error"
                    ? "Forecast service error. Try refresh."
                    : "Wave inputs are incomplete. Open for wind and tide."}
                </span>
              )}
              <ChevronRight className="rowChevron" size={18} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>

      <details className="dataDisclosure">
        <summary>
          <span><Database size={17} aria-hidden="true" /> Data &amp; confidence</span>
          <span>{sourceUpdates.length > 0 ? `${sourceUpdates.length} coastal source update${sourceUpdates.length === 1 ? "" : "s"}` : "Wave source pending"}</span>
        </summary>
        <div className="disclosureBody">
          <p>
            Size ranges use mapped CDIP MOP significant wave height at 10/15 m where available; the NWS fallback uses an explicit cold-start spot scale. They are modeled planning estimates, not measured wave-face height. Three-hour surface labels use the roughest hourly wind in the interval; size and cleanliness stay separate so you can make the call.
          </p>
          <p>This is for personal surf planning, not navigation or maritime safety.</p>
        </div>
      </details>
    </>
  );
}

function Timeline({
  spot,
  windows,
  now,
  selectedAt,
  onSelect
}: {
  spot: ApiSpot;
  windows: ScoredForecastWindow[];
  now: Date;
  selectedAt: string | null;
  onSelect: (value: string) => void;
}) {
  const dateKeys = availableLocalDateKeys(spot, windows, now).slice(0, 5);
  const planningWindows = windows.filter((window) => isPlanningWindow(window, spot.timezone, now));
  const maxHeight = Math.max(1, ...planningWindows.map((window) => window.waveHeightFt ?? 0));

  return (
    <div className="timelineViewport" tabIndex={0} aria-label="Five-day daylight forecast timeline">
      <div className="timeline">
        {dateKeys.map((dateKey) => {
          const dayWindows = planningWindows.filter(
            (window) => localDateParts(window.forecastAt, spot.timezone).key === dateKey
          );
          return (
            <section className="timelineDay" key={dateKey}>
              <h3>{dayWindows[0] ? formatDay(dayWindows[0].forecastAt, spot.timezone) : dateKey}</h3>
              <div className="timelineSlots">
                {dayWindows.map((window) => {
                  const surface =
                    window.ratingStatus === "scored" ? surfaceCondition(spot, window) : "unknown";
                  const selected = selectedAt === window.forecastAt;
                  const barHeight = window.waveHeightFt === null ? 8 : Math.max(12, (window.waveHeightFt / maxHeight) * 76);
                  return (
                    <button
                      className={`timelineSlot ${surface}${selected ? " selected" : ""}`}
                      type="button"
                      key={window.forecastAt}
                      onClick={() => onSelect(window.forecastAt)}
                      aria-pressed={selected}
                      aria-label={`${formatClock(window.forecastAt, spot.timezone)}, ${surfHeightRange(window.waveHeightFt)}, ${surface}`}
                    >
                      <span className="heightPlot" aria-hidden="true">
                        <span style={{ height: `${barHeight}%` }} />
                      </span>
                      <strong>{surfHeightRange(window.waveHeightFt).replace(" ft", "")}</strong>
                      <small>{formatClock(window.forecastAt, spot.timezone)}</small>
                      <span className="surfaceBand" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SelectedWindowDetails({ spot, windows, window }: { spot: ApiSpot; windows: ScoredForecastWindow[]; window: ScoredForecastWindow }) {
  const primary = window.primarySwell;
  const secondary = window.secondarySwell;
  return (
    <div className="selectedWindow" aria-live="polite">
      <div className="selectedWindowHeading">
        <div>
          <p className="kicker">Selected window</p>
          <h3>{formatDay(window.forecastAt, spot.timezone)} · {formatWindowSpan(window.forecastAt, spot.timezone)}</h3>
        </div>
        <ConditionPill spot={spot} window={window} />
      </div>
      <dl className="detailGrid">
        <div><dt>Size estimate</dt><dd>{surfHeightRange(window.waveHeightFt)}</dd></div>
        <div><dt>{isCdipMop(window) ? "MOP wave input" : "Primary swell"}</dt><dd>{primarySwellText(window)}</dd></div>
        <div><dt>Secondary swell</dt><dd>{secondary?.heightFt !== null && secondary?.heightFt !== undefined ? `${secondary.heightFt.toFixed(1)} ft @ ${formatNumber(secondary.periodSec, "s")} ${cardinalDirection(secondary.directionDeg)}` : "None resolved"}</dd></div>
        <div><dt>Wind</dt><dd>{cardinalDirection(window.windDirectionDeg)} {formatNumber(window.windSpeedKt, " kt")} · {windRelation(spot, window)}</dd></div>
        <div><dt>Tide</dt><dd>{formatNumber(window.tideFt, " ft", 1)} · {tideTrend(windows, window)}</dd></div>
        <div><dt>Confidence</dt><dd>{confidenceLabel(window.confidence)} · {formatFreshness(window.sourceFreshnessMinutes).replace("Updated ", "")}</dd></div>
      </dl>
    </div>
  );
}

function SpotDetail({ summary, summaries, now }: { summary: SpotSummary; summaries: SpotSummary[]; now: Date }) {
  const { spot, windows, forecast } = summary;
  const observation = forecast?.status === "ready" ? forecast.data.observation : null;
  const current = closestWindow(windows, now);
  const reportDateKey = availableLocalDateKeys(spot, windows, now)[0];
  const dayBest = reportDateKey ? calmestWindow(spot, windows, now, reportDateKey) : undefined;
  const featured = dayBest ?? current;
  const [selectedAt, setSelectedAt] = useState<string | null>(featured?.forecastAt ?? null);
  const selected = windows.find((window) => window.forecastAt === selectedAt) ?? featured;
  const sourceCaveats = unique([
    ...(forecast?.status === "ready" ? [forecast.data.sourceNote] : []),
    ...windows.flatMap((window) => window.caveats)
  ]).filter(Boolean);
  const capabilities = unique(windows.flatMap((window) => window.activeCapabilities));
  const hazards = activeHazardMessages([featured]);

  return (
    <>
      <nav className="spotNav" aria-label="Surf spots">
        <a className="backLink" href="/"><ArrowLeft size={17} aria-hidden="true" /> Daily report</a>
        <div className="spotLinks">
          {summaries.map((item) => (
            <a className={item.spot.id === spot.id ? "active" : undefined} href={forecastHref(item.spot.id)} key={item.spot.id}>
              {item.spot.name.replace("Ocean Beach ", "OB ")}
            </a>
          ))}
        </div>
      </nav>

      <section className="spotHero">
        <div>
          <p className="kicker">Five-day forecast</p>
          <h1>{spot.name}</h1>
          {featured ? (
            <p className="spotCall">
              <strong>{formatDay(featured.forecastAt, spot.timezone, false)}:</strong> {surfHeightRange(featured.waveHeightFt)} modeled size and {surfaceCondition(spot, featured)} surface.
              {dayBest && <> Calmest window: <strong>{formatWindowSpan(dayBest.forecastAt, spot.timezone)}</strong>.</>}
            </p>
          ) : (
            <p className="spotCall">No reliable wave call yet. Wind and tide may still be available below.</p>
          )}
        </div>
        {featured && <ConditionPill spot={spot} window={featured} />}
      </section>

      {forecast?.status === "error" && (
        <div className="errorBanner" role="alert">
          <Info size={18} aria-hidden="true" />
          <span>This spot forecast could not be loaded. Try refresh; no conditions were inferred.</span>
        </div>
      )}

      <HazardNotice messages={hazards} />

      <section className="forecastSection" aria-labelledby="forecast-heading">
        <div className="sectionTitle">
          <div><p className="kicker">6am–6pm</p><h2 id="forecast-heading">Forecast timeline</h2></div>
          <div className="timelineLegend" aria-label="Surface condition legend">
            <span className="clean">Clean</span><span className="fair">Fair</span><span className="choppy">Choppy</span><span>Unknown</span>
          </div>
        </div>
        {windows.length > 0 ? (
          <>
            <Timeline spot={spot} windows={windows} now={now} selectedAt={selectedAt} onSelect={setSelectedAt} />
            {selected && <SelectedWindowDetails spot={spot} windows={windows} window={selected} />}
          </>
        ) : (
          <div className="emptyState"><Info size={20} aria-hidden="true" /><span>No forecast windows returned.</span></div>
        )}
      </section>

      <details className="dataDisclosure">
        <summary>
          <span><Radio size={17} aria-hidden="true" /> Data &amp; confidence</span>
          <span>{featured ? `${confidenceLabel(featured.confidence)} confidence` : "No call"}</span>
        </summary>
        <div className="disclosureBody">
          {featured?.waveProvenance && (
            <dl className="provenanceGrid">
              <div><dt>Wave source</dt><dd>{featured.waveProvenance.provider}</dd></div>
              <div><dt>Source updated</dt><dd>{formatFetchedAt(featured.waveProvenance.sourceUpdatedAt)}</dd></div>
              <div><dt>{isCdipMop(featured) ? "MOP Hs at point" : "Raw coastal height"}</dt><dd>{featured.waveProvenance.rawSignificantHeightFt.toFixed(1)} ft</dd></div>
              {isCdipMop(featured) ? (
                <>
                  <div><dt>Spot exposure factor</dt><dd>× {(featured.waveProvenance.exposureScale ?? 1).toFixed(2)}</dd></div>
                  <div><dt>Height used</dt><dd>{featured.waveProvenance.modeledNearshoreSignificantHeightFt?.toFixed(1) ?? "—"} ft modeled Hs</dd></div>
                </>
              ) : (
                <div><dt>Spot exposure factor</dt><dd>× {featured.waveProvenance.breakingHeightScale.toFixed(2)}</dd></div>
              )}
            </dl>
          )}
          {observation && (
            <p>
              Buoy {observation.stationId}: {observation.waveHeightFt.toFixed(1)} ft @ {formatNumber(observation.dominantPeriodSec ?? observation.averagePeriodSec, "s")} {cardinalDirection(observation.meanWaveDirectionDeg)} · {observation.waterTempF === null ? "water temperature unavailable" : `${observation.waterTempF.toFixed(0)}°F water`} · {formatFreshness(observation.sourceFreshnessMinutes).replace("Updated ", "")}.
            </p>
          )}
          <p>Active layers: {capabilities.length > 0 ? capabilities.map(capabilityName).join(" · ") : "none"}.</p>
          {sourceCaveats.length > 0 && <ul>{sourceCaveats.slice(0, 6).map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>}
          <p>This forecast is for personal surf planning, not navigation or maritime safety.</p>
        </div>
      </details>
    </>
  );
}

function capabilityName(capability: SourceCapability): string {
  const labels: Record<SourceCapability, string> = {
    forecast_wave_offshore: "offshore wave model",
    forecast_wave_nearshore: "coastal wave model",
    observed_wave: "buoy observation",
    tide: "NOAA tide",
    wind: "NWS wind",
    hazard: "active hazard",
    bathymetry: "bathymetry",
    quality_label: "quality labels",
    comparison_forecast: "comparison model"
  };
  return labels[capability];
}

function LoadingState() {
  return (
    <div className="loadingState" aria-live="polite">
      <Waves size={26} aria-hidden="true" />
      <div><strong>Reading the coast</strong><span>Loading wave, wind, and tide forecasts…</span></div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<DashboardState>(initialState);
  const [now, setNow] = useState(() => new Date());
  const activeController = useRef<AbortController | null>(null);
  const lastFetchedAt = useRef<number | null>(null);

  const loadDashboard = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const spotsPayload = await fetchJson<SpotsResponse>("/api/spots", controller.signal);
      const forecastEntries = await Promise.all(
        spotsPayload.spots.map(async (spot) => {
          try {
            const data = await fetchJson<ForecastResponse>(`/api/forecast/${spot.id}`, controller.signal);
            return [spot.id, { status: "ready", data } satisfies ForecastResult] as const;
          } catch (error) {
            return [spot.id, { status: "error", error: errorMessage(error) } satisfies ForecastResult] as const;
          }
        })
      );
      if (controller.signal.aborted) return;
      setState({
        loading: false,
        error: null,
        spots: spotsPayload.spots,
        forecasts: Object.fromEntries(forecastEntries) as Partial<Record<SpotId, ForecastResult>>,
        fetchedAt: new Date().toISOString()
      });
      lastFetchedAt.current = Date.now();
      setNow(new Date());
    } catch (error) {
      if (controller.signal.aborted) return;
      lastFetchedAt.current = Date.now();
      setState((current) => ({ ...current, loading: false, error: errorMessage(error), fetchedAt: new Date().toISOString() }));
    }
  }, []);

  useEffect(() => {
    void loadDashboard();
    const interval = window.setInterval(() => void loadDashboard(), 15 * 60 * 1000);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const age = lastFetchedAt.current === null ? Number.POSITIVE_INFINITY : Date.now() - lastFetchedAt.current;
      if (age > 5 * 60 * 1000) void loadDashboard();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      activeController.current?.abort();
    };
  }, [loadDashboard]);

  const summaries = useMemo<SpotSummary[]>(
    () =>
      state.spots.map((spot) => {
        const forecast = state.forecasts[spot.id];
        return {
          spot,
          forecast,
          windows: forecast?.status === "ready" ? forecast.data.windows : []
        };
      }),
    [state.forecasts, state.spots]
  );
  const selectedSpotId = activeSpotId();
  const selectedSummary = summaries.find((summary) => summary.spot.id === selectedSpotId);

  return (
    <main className="appShell">
      <Header state={state} onRefresh={() => void loadDashboard()} />
      {state.error && <div className="errorBanner" role="alert"><Info size={18} aria-hidden="true" /> {state.error}</div>}
      {state.loading && state.spots.length === 0 ? (
        <LoadingState />
      ) : selectedSummary ? (
        <SpotDetail summary={selectedSummary} summaries={summaries} now={now} />
      ) : (
        <DailyReport summaries={summaries} now={now} />
      )}
      <footer>
        <span>Public NOAA / NWS data · deterministic spot scoring</span>
        <span>Personal planning only</span>
      </footer>
    </main>
  );
}
