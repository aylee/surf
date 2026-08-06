import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  sourceFreshnessVerdict,
  type ApiSpot,
  type ForecastResponse,
  type ScoredForecastWindow,
  type SourceCapability,
  type SourceFreshness,
  type SpotId,
  type SpotsResponse
} from "@surf/contracts";
import {
  ArrowLeft,
  AlertTriangle,
  ChevronRight,
  Clock3,
  Database,
  Info,
  RefreshCw,
  Waves
} from "lucide-react";
import {
  availableLocalDateKeys,
  calmestWindow,
  cardinalDirection,
  earliestAvailableLocalDateKey,
  formatDay,
  formatWindowSpan,
  selectedSpotIdFromSearch,
  surfaceCondition,
  surfHeightRange,
  windRelation,
  type SurfaceCondition
} from "./forecast-view";
import { ForecastWorkbench } from "./features/workbench/ForecastWorkbench";
import {
  isUsableForecastResponse,
  parseUsableForecastResponse
} from "./features/workbench/forecast-health";

type ForecastResult =
  | { status: "ready"; data: ForecastResponse; fetchedAt: string }
  | { status: "error"; error: string };

type DashboardState = {
  loading: boolean;
  error: string | null;
  notice: string | null;
  delayedSpotIds: SpotId[];
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
  notice: null,
  delayedSpotIds: [],
  spots: [],
  forecasts: {},
  fetchedAt: null
};

const NORMAL_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DELAYED_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CATALOG_REFRESH_DELAY_NOTICE =
  "The latest update is delayed. Showing the last forecast we loaded.";

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

async function fetchForecastJson(path: string, signal: AbortSignal): Promise<ForecastResponse> {
  return parseUsableForecastResponse(await fetchJson<unknown>(path, signal));
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

function formatSourceAgeRange(values: number[]): string {
  if (values.length === 0) return "Source ages unavailable";
  const formatAge = (minutes: number) => {
    if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / (24 * 60))}d`;
  };
  const minimumLabel = formatAge(Math.min(...values));
  const maximumLabel = formatAge(Math.max(...values));
  // Compare the formatted labels, not the raw minutes: distinct ages that
  // round to the same label collapse to one value instead of "3h–3h".
  return minimumLabel === maximumLabel
    ? `Source data ${maximumLabel} old`
    : `Sources ${minimumLabel}–${maximumLabel} old`;
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

function formatClockTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

// A retained forecast can outlive the calendar day during a long outage; a
// bare clock time would then read as "today" and understate the data's age.
function formatLastGoodTime(value: string): string {
  return new Date(value).toDateString() === new Date().toDateString()
    ? formatClockTime(value)
    : formatFetchedAt(value);
}

function formatBannerAge(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  // Day tier mirrors the header chip so both surfaces describe a multi-day
  // outage with the same unit.
  if (minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))}d`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10}h`;
}

function formatCadence(expectedCadenceMinutes: number): string {
  if (expectedCadenceMinutes <= 90) return "hourly";
  if (expectedCadenceMinutes >= 1440) return "daily";
  return `every ${Math.round(expectedCadenceMinutes / 60)} hours`;
}

const lateSourceLabels: Partial<Record<SourceCapability, string>> = {
  observed_wave: "Buoy observations",
  wind: "Wind forecast",
  tide: "Tide predictions",
  forecast_wave_nearshore: "Wave model data",
  forecast_wave_offshore: "Wave model data"
};

// The banner names actionable causes only. A source is actionable when the
// contracts verdict over its own shipped cadence says "late"; fresh and aging
// sources stay quiet. Whole-source absence (null age) belongs to per-window
// caveats and the data-health panel, not the dashboard banner.
function lateSourceNotice(
  forecasts: Partial<Record<SpotId, ForecastResult>>,
  spots: ApiSpot[]
): string | null {
  let worst: { entry: SourceFreshness; ratio: number; spotId: string } | null = null;
  let readySpotCount = 0;
  const lateSpotsBySource = new Map<string, Set<string>>();
  for (const [spotId, result] of Object.entries(forecasts)) {
    if (result?.status !== "ready") continue;
    readySpotCount += 1;
    const window = result.data.windows[0];
    for (const entry of window?.sourceFreshness ?? []) {
      // Placeholder entries (a source that never produced data) carry a null
      // age; their absence is caveat/panel territory, and bannering them
      // would render a nonsense "1m old". Pre-cadence entries return a null
      // verdict and stay with their shipped status.
      if (entry.freshnessMinutes === null) continue;
      if (entry.expectedCadenceMinutes === null || entry.expectedCadenceMinutes === undefined) continue;
      if (sourceFreshnessVerdict(entry) !== "late") continue;
      const lateSpots = lateSpotsBySource.get(entry.sourceId) ?? new Set<string>();
      lateSpots.add(spotId);
      lateSpotsBySource.set(entry.sourceId, lateSpots);
      const ratio = entry.freshnessMinutes / (entry.expectedCadenceMinutes + (entry.graceMinutes ?? 0));
      if (!worst || ratio > worst.ratio) worst = { entry, ratio, spotId };
    }
  }
  if (!worst) return null;
  const label = lateSourceLabels[worst.entry.capability] ?? "Source data";
  // A source that is late for only some spots names the worst one so the
  // banner cannot contradict another spot's fresh source panel; a source
  // late everywhere states the regional truth without singling a spot out.
  const affectedSpots = lateSpotsBySource.get(worst.entry.sourceId)?.size ?? 0;
  const scope = affectedSpots < readySpotCount
    ? ` at ${spots.find((spot) => spot.id === worst.spotId)?.name ?? worst.spotId}`
    : "";
  return `${label}${scope} ${formatBannerAge(worst.entry.freshnessMinutes ?? 0)} old; expected ${formatCadence(
    worst.entry.expectedCadenceMinutes ?? 0
  )}.`;
}

function delayedSpotsNotice(names: string[], lastGoodAt: string | null): string {
  const first = names[0] ?? "Some spots";
  const others = names.length - 1;
  const subject = others <= 0 ? first : `${first} + ${others} other${others === 1 ? "" : "s"}`;
  const verb = others <= 0 ? "is" : "are";
  return lastGoodAt
    ? `${subject} ${verb} refreshing — showing data from ${formatLastGoodTime(lastGoodAt)}.`
    : `${subject} ${verb} refreshing.`;
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

function windowConditionText(spot: ApiSpot, window: ScoredForecastWindow): string {
  const surface = surfaceCondition(spot, window);
  if (window.ratingStatus !== "scored") return "No reliable surf call";
  if (surface === "unknown") return "Wind unavailable";
  if (surface === "fair") return "Fair surface";
  return surface[0]!.toUpperCase() + surface.slice(1);
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
  const sourceAgeRange = formatSourceAgeRange(sourceAges);

  return (
    <header className="appHeader">
      <a className="wordmark" href="/" aria-label="Surf daily report home">
        <span className="wordmarkMark" aria-hidden="true">≈</span>
        <span>surf</span>
      </a>
      <div className="headerActions">
        <span className="updateLabel" title={state.fetchedAt ? `Browser fetched ${formatFetchedAt(state.fetchedAt)}. ${sourceAgeRange}.` : sourceAgeRange}>
          <Clock3 size={15} aria-hidden="true" />
          {sourceAgeRange}
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
  const reportDateKey = earliestAvailableLocalDateKey(
    summaries.map((summary) => ({
      spot: summary.spot,
      windows: summary.windows,
      sunPhases: summary.forecast?.status === "ready" ? summary.forecast.data.sunPhases : undefined
    })),
    now
  );
  const rows = summaries
    .map((summary) => ({
      ...summary,
      window: reportDateKey
        ? calmestWindow(
            summary.spot,
            summary.windows,
            now,
            reportDateKey,
            summary.forecast?.status === "ready" ? summary.forecast.data.sunPhases : undefined
          )
        : undefined
    }))
    .sort(sortDailyRows);
  const report = regionalReport(rows, reportDateKey);
  const hazards = activeHazardMessages(rows.map((row) => row.window));

  return (
    <>
      <section className="reportHero" aria-labelledby="daily-report-title">
        <p className="kicker">NorCal daily surf report</p>
        <h1 id="daily-report-title">{report.title}</h1>
        <p className="reportLead">{report.body}</p>
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
                    ? "Forecast update delayed. Open for available details."
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

function SpotDetail({
  summary,
  summaries,
  now,
  onForecastRecovered
}: {
  summary: SpotSummary;
  summaries: SpotSummary[];
  now: Date;
  onForecastRecovered: (spotId: SpotId, forecast: ForecastResponse) => void;
}) {
  const { spot, windows, forecast } = summary;
  const forecastData = forecast?.status === "ready" ? forecast.data : null;
  const reportDateKey = availableLocalDateKeys(
    spot,
    windows,
    now,
    forecastData?.sunPhases
  )[0];
  const dayBest = reportDateKey
    ? calmestWindow(spot, windows, now, reportDateKey, forecastData?.sunPhases)
    : undefined;
  const current = windows
    .filter((window) => window.ratingStatus === "scored")
    .sort(
      (left, right) =>
        Math.abs(new Date(left.forecastAt).getTime() - now.getTime()) -
        Math.abs(new Date(right.forecastAt).getTime() - now.getTime())
    )[0];
  const featured = dayBest ?? current;
  const hazards = activeHazardMessages(windows);
  // The slim header's freshness badge is PR-B's verdict over the featured
  // window's own shipped cadence — worst source wins. It applies the same
  // exclusions as the dashboard banner: an entry with no cadence is never
  // re-judged, and a whole-source absence (null age) is missing rather than
  // late — that state belongs to the caveats and the provenance panel, which
  // label it "Missing". Judging it here would contradict both surfaces.
  const featuredVerdicts = (featured?.sourceFreshness ?? [])
    .filter((entry) => entry.freshnessMinutes !== null)
    .map((entry) => sourceFreshnessVerdict(entry))
    .filter((verdict): verdict is Exclude<ReturnType<typeof sourceFreshnessVerdict>, null> => verdict !== null);
  const spotFreshness = featuredVerdicts.length === 0
    ? null
    : featuredVerdicts.includes("late")
      ? "late"
      : featuredVerdicts.includes("aging")
        ? "aging"
        : "fresh";

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

      <section className="spotHero spotHeroSlim">
        <div>
          <h1>{spot.name}</h1>
          {featured ? (
            <p className="spotCall">
              <strong>{formatDay(featured.forecastAt, spot.timezone, false)}:</strong> {formatNumber(featured.waveState?.modeledNearshoreHeightFt ?? featured.waveHeightFt, " ft", 1)} modeled nearshore Hs and {surfaceCondition(spot, featured)} surface.
              {dayBest && <> Calmest window: <strong>{formatWindowSpan(dayBest.forecastAt, spot.timezone)}</strong>.</>}
            </p>
          ) : (
            <p className="spotCall">No reliable wave call yet. Wind and tide may still be available below.</p>
          )}
        </div>
        {spotFreshness && (
          <span className={`freshnessBadge ${spotFreshness}`}>
            Data {spotFreshness}
          </span>
        )}
      </section>

      <HazardNotice messages={hazards} />
      <ForecastWorkbench
        spot={spot}
        initialForecast={forecastData}
        initialError={forecast?.status === "error" ? forecast.error : null}
        now={now}
        onForecastRecovered={onForecastRecovered}
      />
    </>
  );
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
    setState((current) => ({ ...current, loading: true, error: null, notice: null }));
    try {
      const spotsPayload = await fetchJson<SpotsResponse>("/api/spots", controller.signal);
      const forecastEntries = await Promise.all(
        spotsPayload.spots.map(async (spot) => {
          try {
            const data = await fetchForecastJson(`/api/forecast/${spot.id}`, controller.signal);
            return [
              spot.id,
              { status: "ready", data, fetchedAt: new Date().toISOString() } satisfies ForecastResult
            ] as const;
          } catch (error) {
            return [spot.id, { status: "error", error: errorMessage(error) } satisfies ForecastResult] as const;
          }
        })
      );
      if (controller.signal.aborted) return;
      const fetchedAt = new Date().toISOString();
      setState((current) => {
        let retainedForecastCount = 0;
        const forecasts = Object.fromEntries(
          forecastEntries.map(([spotId, result]) => {
            const previous = current.forecasts[spotId];
            if (result.status === "error" && previous?.status === "ready") {
              retainedForecastCount += 1;
              return [spotId, previous] as const;
            }
            return [spotId, result] as const;
          })
        ) as Partial<Record<SpotId, ForecastResult>>;
        const failedForecastCount = forecastEntries.filter(([, result]) => result.status === "error").length;
        const delayedSpotIds = forecastEntries.flatMap(([spotId, result]) =>
          result.status === "error" ? [spotId] : []
        );
        const delayedSpotNames = delayedSpotIds.map(
          (spotId) => spotsPayload.spots.find((spot) => spot.id === spotId)?.name ?? spotId
        );
        // The "showing data from" time is the oldest per-spot fetch time among
        // the retained forecasts for the delayed spots — never the dashboard
        // clock, which advances on every refresh pass while retained data
        // stays frozen at its real last success.
        const retainedFetchTimes = delayedSpotIds.flatMap((spotId) => {
          const previous = current.forecasts[spotId];
          return previous?.status === "ready" ? [previous.fetchedAt] : [];
        });
        const oldestRetainedAt = retainedFetchTimes.length > 0
          ? retainedFetchTimes.reduce((oldest, candidate) => (candidate < oldest ? candidate : oldest))
          : null;
        const notice = failedForecastCount === 0
          ? lateSourceNotice(forecasts, spotsPayload.spots)
          : retainedForecastCount > 0
            ? delayedSpotsNotice(delayedSpotNames, oldestRetainedAt)
            : "Some forecasts are temporarily unavailable. We'll try again automatically.";
        return {
          loading: false,
          error: null,
          notice,
          delayedSpotIds,
          spots: spotsPayload.spots,
          forecasts,
          fetchedAt
        };
      });
      lastFetchedAt.current = Date.now();
      setNow(new Date());
    } catch {
      if (controller.signal.aborted) return;
      lastFetchedAt.current = Date.now();
      setState((current) => current.spots.length > 0
        ? {
            ...current,
            loading: false,
            error: null,
            notice: CATALOG_REFRESH_DELAY_NOTICE
          }
        : {
            ...current,
            loading: false,
            error: "Surf data is temporarily unavailable. Please try again.",
            notice: null,
            delayedSpotIds: []
          });
    }
  }, []);

  const acceptRecoveredForecast = useCallback((spotId: SpotId, forecast: ForecastResponse) => {
    if (!isUsableForecastResponse(forecast)) return;
    setState((current) => {
      const wasDelayed = current.delayedSpotIds.includes(spotId);
      const delayedSpotIds = current.delayedSpotIds.filter((candidate) => candidate !== spotId);
      // A recovery changes the delayed set, so a delayed-spots notice must be
      // recomputed for the REMAINING spots — never left naming the recovered
      // one. The catalog-refresh warning is not ours to clear here.
      const remainingNames = delayedSpotIds.map(
        (candidate) => current.spots.find((spot) => spot.id === candidate)?.name ?? candidate
      );
      const remainingRetainedTimes = delayedSpotIds.flatMap((candidate) => {
        const previous = current.forecasts[candidate];
        return previous?.status === "ready" ? [previous.fetchedAt] : [];
      });
      const oldestRemainingAt = remainingRetainedTimes.length > 0
        ? remainingRetainedTimes.reduce((oldest, candidate) => (candidate < oldest ? candidate : oldest))
        : null;
      const notice = !wasDelayed || current.notice === CATALOG_REFRESH_DELAY_NOTICE
        ? current.notice
        : delayedSpotIds.length === 0
          ? null
          : delayedSpotsNotice(remainingNames, oldestRemainingAt);
      return {
        ...current,
        forecasts: {
          ...current.forecasts,
          [spotId]: { status: "ready", data: forecast, fetchedAt: new Date().toISOString() }
        },
        notice,
        delayedSpotIds,
        fetchedAt: new Date().toISOString()
      };
    });
  }, []);

  useEffect(() => {
    void loadDashboard();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const age = lastFetchedAt.current === null ? Number.POSITIVE_INFINITY : Date.now() - lastFetchedAt.current;
      if (age > 5 * 60 * 1000) void loadDashboard();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      activeController.current?.abort();
    };
  }, [loadDashboard]);

  const refreshIntervalMs = state.delayedSpotIds.length > 0
    ? DELAYED_REFRESH_INTERVAL_MS
    : NORMAL_REFRESH_INTERVAL_MS;

  useEffect(() => {
    const interval = window.setInterval(() => void loadDashboard(), refreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [loadDashboard, refreshIntervalMs]);

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
  const selectedSpotId = selectedSpotIdFromSearch(
    window.location.search,
    state.spots.map((spot) => spot.id)
  );
  const selectedSummary = summaries.find((summary) => summary.spot.id === selectedSpotId);

  return (
    <main className="appShell">
      <Header state={state} onRefresh={() => void loadDashboard()} />
      {state.error && <div className="errorBanner" role="alert"><Info size={18} aria-hidden="true" /> {state.error}</div>}
      {state.notice && <div className="noticeBanner" role="status"><Info size={18} aria-hidden="true" /> {state.notice}</div>}
      {state.loading && state.spots.length === 0 ? (
        <LoadingState />
      ) : selectedSummary ? (
        <SpotDetail
          summary={selectedSummary}
          summaries={summaries}
          now={now}
          onForecastRecovered={acceptRecoveredForecast}
        />
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
