import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  sourceFreshnessVerdict,
  type ApiSpot,
  type ForecastHazard,
  type ForecastResponse,
  type ScoredForecastWindow,
  type SourceCapability,
  type SourceFreshness,
  type SpotId,
  type SpotsResponse
} from "@surf/contracts";
import { intervalOverlapsRange } from "@surf/forecast-core";
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
  availableDisplayLocalDateKeys,
  availableLocalDateKeys,
  bestWindowSelection,
  cardinalDirection,
  earliestAvailableLocalDateKey,
  formatDay,
  formatWindowSpan,
  localDateParts,
  selectedSpotIdFromSearch,
  surfaceCondition,
  surfHeightRange,
  windRelation
} from "./forecast-view";
import type { BestWindowSelection } from "./forecast-view";
import { ForecastWorkbench } from "./features/workbench/ForecastWorkbench";
import { localDayDomain } from "./features/workbench/workbench-time";
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
  selection: BestWindowSelection | undefined;
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

// Keep presentation order separate from the reference catalog, whose order is
// also used by ingest orchestration. This groups nearby breaks for browsing
// from San Francisco through Marin, then Santa Cruz.
const SPOT_DISPLAY_ORDER = [
  "obsf-north",
  "obsf-central",
  "obsf-south",
  "linda-mar",
  "rodeo-beach",
  "stinson",
  "bolinas",
  "steamer-lane",
  "pleasure-point",
  "cowells",
  "jacks"
] satisfies readonly SpotId[];
const SPOT_DISPLAY_RANK = new Map(
  SPOT_DISPLAY_ORDER.map((spotId, index) => [spotId, index])
);

function sortSpotsByDisplayOrder(left: ApiSpot, right: ApiSpot): number {
  return (SPOT_DISPLAY_RANK.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (SPOT_DISPLAY_RANK.get(right.id) ?? Number.MAX_SAFE_INTEGER);
}

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

function formatNumber(value: number | null, suffix: string, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}${suffix}`;
}

function formatSourceAgeRange(values: number[]): string {
  if (values.length === 0) return "Source ages unavailable";
  const minimumLabel = formatSourceAge(Math.min(...values));
  const maximumLabel = formatSourceAge(Math.max(...values));
  // Compare the formatted labels, not the raw minutes: distinct ages that
  // round to the same label collapse to one value instead of "3h–3h".
  return minimumLabel === maximumLabel
    ? `Source data ${maximumLabel} old`
    : `Sources ${minimumLabel}–${maximumLabel} old`;
}

function formatSourceAge(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

function formatSourceCadence(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "its expected cadence";
  if (minutes <= 90) return "hourly";
  if (minutes >= 24 * 60) return "daily";
  return `every ${Math.round(minutes / 60)} hours`;
}

const REQUIRED_SOURCE_CAPABILITIES = new Set<SourceCapability>([
  "forecast_wave_offshore",
  "forecast_wave_nearshore",
  "wind",
  "tide"
]);

const headerSourceLabels: Partial<Record<SourceCapability, string>> = {
  forecast_wave_offshore: "Wave model",
  forecast_wave_nearshore: "Wave model",
  wind: "Wind forecast",
  tide: "Tide data"
};

type HeaderSourceIssue = {
  entry: SourceFreshness;
  kind: "late" | "missing";
  spotName: string;
};

function headerReferenceWindow(
  forecast: ForecastResponse,
  now: Date
): ScoredForecastWindow | undefined {
  const nowMs = now.getTime();
  const recommendation = forecast.recommendations
    ?.filter((candidate) => {
      const endMs = Date.parse(candidate.endAt);
      return Number.isFinite(endMs) && endMs >= nowMs;
    })
    .sort((left, right) => left.startAt.localeCompare(right.startAt))[0];
  if (recommendation) return recommendation.representative;

  const ordered = forecast.windows
    .map((window) => ({ window, timestamp: Date.parse(window.forecastAt) }))
    .filter((candidate) => Number.isFinite(candidate.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
  return ordered.find((candidate) => candidate.timestamp >= nowMs)?.window
    ?? ordered.at(-1)?.window;
}

function headerSourceIssue(state: DashboardState, now: Date): HeaderSourceIssue | null {
  const issues: HeaderSourceIssue[] = [];
  for (const spot of state.spots) {
    const result = state.forecasts[spot.id];
    if (result?.status !== "ready") continue;
    // Full-day responses begin at local midnight, which can be historical by
    // the time the report is read. Judge the recommendation/live horizon, not
    // a retained elapsed row; if the entire payload is elapsed, use its tail.
    const reference = headerReferenceWindow(result.data, now);
    for (const entry of reference?.sourceFreshness ?? []) {
      if (!REQUIRED_SOURCE_CAPABILITIES.has(entry.capability)) continue;
      if (entry.status === "missing") {
        issues.push({ entry, kind: "missing", spotName: spot.name });
        continue;
      }
      const verdict = sourceFreshnessVerdict(entry);
      if (verdict === "late" || (verdict === null && entry.status === "stale")) {
        issues.push({ entry, kind: "late", spotName: spot.name });
      }
    }
  }
  return issues.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "missing" ? -1 : 1;
    return (right.entry.freshnessMinutes ?? 0) - (left.entry.freshnessMinutes ?? 0);
  })[0] ?? null;
}

function headerSourceIssueCopy(issue: HeaderSourceIssue): { label: string; detail: string } {
  const source = headerSourceLabels[issue.entry.capability] ?? "Required source";
  if (issue.kind === "missing") {
    return {
      label: `${source} unavailable`,
      detail: `${source} at ${issue.spotName} is unavailable.`
    };
  }
  const age = issue.entry.freshnessMinutes === null
    ? "older than expected"
    : `${formatSourceAge(issue.entry.freshnessMinutes)} old`;
  return {
    label: `${source} delayed`,
    detail: `${source} at ${issue.spotName} is ${age}; expected ${formatSourceCadence(issue.entry.expectedCadenceMinutes)}.`
  };
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

function sortDailyRowsByForecastQuality(left: DailySpotRow, right: DailySpotRow): number {
  if (!left.window && !right.window) return 0;
  if (!left.window) return 1;
  if (!right.window) return -1;
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

function windSnapshot(spot: ApiSpot, window: ScoredForecastWindow): string {
  const relation = windRelation(spot, window);
  if (window.windSpeedKt === null || window.windDirectionDeg === null) return relation;
  return `${relation} · ${cardinalDirection(window.windDirectionDeg)} ${formatNumber(window.windSpeedKt, " kt")}`;
}

function regionalReport(rows: DailySpotRow[], dateKey: string | null): { title: string; body: string } {
  const ready = rows
    .filter((row): row is DailySpotRow & { window: ScoredForecastWindow } => Boolean(row.window))
    .sort(sortDailyRowsByForecastQuality);
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
    body: `${top.spot.name} has the best overall window around ${formatWindowSpan(
      top.selection?.startAt ?? top.window.forecastAt,
      top.spot.timezone,
      top.selection?.endAt
    )}. ${sizeStory}`
  };
}

function ConditionPill({ spot, window }: { spot: ApiSpot; window: ScoredForecastWindow }) {
  const surface = window.ratingStatus === "scored" ? surfaceCondition(spot, window) : "unknown";
  return <span className={`conditionPill ${surface}`}>{windowConditionText(spot, window)}</span>;
}

export type HazardNoticeItem = {
  headline: string;
  status: "active" | "upcoming";
};

function dedupeHazardNotices(notices: HazardNoticeItem[]): HazardNoticeItem[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = `${notice.status}\u0000${notice.headline}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hazardNoticesForDate(
  hazards: ForecastHazard[],
  now: Date,
  dateKey: string | null,
  timezone: string
): HazardNoticeItem[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const day = dateKey ? localDayDomain(dateKey, timezone) : null;
  const notices = hazards.flatMap((hazard): HazardNoticeItem[] => {
    const startsAtMs = hazard.startsAt === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(hazard.startsAt);
    const endsAtMs = hazard.endsAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(hazard.endsAt);
    if (
      (hazard.startsAt !== null && !Number.isFinite(startsAtMs)) ||
      (hazard.endsAt !== null && !Number.isFinite(endsAtMs)) ||
      endsAtMs <= startsAtMs ||
      endsAtMs <= nowMs
    ) {
      return [];
    }
    if (
      !day ||
      !intervalOverlapsRange(
        new Date(day.start).toISOString(),
        new Date(day.end).toISOString(),
        hazard.startsAt,
        hazard.endsAt
      )
    ) {
      return [];
    }
    if (startsAtMs <= nowMs && nowMs < endsAtMs) {
      return [{ headline: hazard.headline, status: "active" }];
    }
    return [{ headline: hazard.headline, status: "upcoming" }];
  });
  return dedupeHazardNotices(notices).sort((left, right) =>
    left.status === right.status ? left.headline.localeCompare(right.headline) : left.status === "active" ? -1 : 1
  );
}

function legacyHazardNoticesForDate(
  windows: ScoredForecastWindow[],
  interval: ForecastResponse["interval"],
  now: Date,
  dateKey: string | null,
  timezone: string
): HazardNoticeItem[] {
  const nowMs = now.getTime();
  const durationMs = interval === "1h" ? 60 * 60_000 : 3 * 60 * 60_000;
  const byHeadline = new Map<string, HazardNoticeItem>();
  for (const window of windows) {
    if (!window.activeCapabilities.includes("hazard")) continue;
    const startMs = Date.parse(window.forecastAt);
    if (!Number.isFinite(startMs)) continue;
    const localDate = localDateParts(window.forecastAt, timezone).key;
    if (!dateKey || localDate !== dateKey) continue;
    const status = startMs <= nowMs && nowMs < startMs + durationMs
      ? "active"
      : startMs > nowMs
        ? "upcoming"
        : null;
    if (!status) continue;
    for (const caveat of window.caveats) {
      const match = /^Active NWS hazard:\s*(.+)$/i.exec(caveat);
      const headline = match?.[1]?.trim();
      if (!headline) continue;
      const current = byHeadline.get(headline);
      if (!current || status === "active") byHeadline.set(headline, { headline, status });
    }
  }
  return dedupeHazardNotices([...byHeadline.values()]);
}

function forecastHazardNotices(
  forecast: ForecastResponse,
  now: Date,
  dateKey: string | null,
  timezone: string
): HazardNoticeItem[] {
  return forecast.hazards === undefined
    ? legacyHazardNoticesForDate(forecast.windows, forecast.interval, now, dateKey, timezone)
    : hazardNoticesForDate(forecast.hazards, now, dateKey, timezone);
}

function HazardNotice({ notices }: { notices: HazardNoticeItem[] }) {
  if (notices.length === 0) return null;
  const active = notices.filter((notice) => notice.status === "active");
  const upcoming = notices.filter((notice) => notice.status === "upcoming");
  return (
    <aside className="hazardNotice" aria-label="National Weather Service hazards">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        {active.length > 0 && <strong>Active NWS hazard</strong>}
        {active.map((notice) => <span key={`active:${notice.headline}`}>{notice.headline}</span>)}
        {upcoming.length > 0 && <strong>Upcoming NWS hazard</strong>}
        {upcoming.map((notice) => <span key={`upcoming:${notice.headline}`}>{notice.headline}</span>)}
      </div>
    </aside>
  );
}

function Header({
  state,
  now,
  onRefresh
}: {
  state: DashboardState;
  now: Date;
  onRefresh: () => void;
}) {
  const sourceAges = Object.values(state.forecasts).flatMap((forecast) =>
    forecast?.status === "ready"
      ? [headerReferenceWindow(forecast.data, now)?.sourceFreshnessMinutes]
          .filter((age): age is number => age !== undefined && Number.isFinite(age))
      : []
  );
  const sourceAgeRange = formatSourceAgeRange(sourceAges);
  const sourceIssue = headerSourceIssue(state, now);
  const sourceStatus = sourceIssue ? headerSourceIssueCopy(sourceIssue) : null;

  return (
    <header className="appHeader">
      <a className="wordmark" href="/" aria-label="Surf daily report home">
        <span className="wordmarkMark" aria-hidden="true">≈</span>
        <span>surf</span>
      </a>
      <div className="headerActions">
        <span
          className={`updateLabel${sourceStatus ? " degraded" : ""}`}
          data-testid="source-status"
          title={sourceStatus?.detail ?? (state.fetchedAt ? `Browser fetched ${formatFetchedAt(state.fetchedAt)}. ${sourceAgeRange}.` : sourceAgeRange)}
          aria-label={sourceStatus?.detail}
        >
          {sourceStatus
            ? <AlertTriangle size={15} aria-hidden="true" />
            : <Clock3 size={15} aria-hidden="true" />}
          {sourceStatus?.label ?? sourceAgeRange}
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
    .map((summary) => {
      const selection = reportDateKey
        ? bestWindowSelection(
            summary.spot,
            summary.windows,
            now,
            reportDateKey,
            summary.forecast?.status === "ready" ? summary.forecast.data.sunPhases : undefined,
            summary.forecast?.status === "ready"
              ? summary.forecast.data.recommendations
              : undefined
          )
        : undefined;
      return { ...summary, selection, window: selection?.window };
    });
  const report = regionalReport(rows, reportDateKey);
  const hazards = dedupeHazardNotices(
    summaries.flatMap((summary) =>
      summary.forecast?.status === "ready"
        ? forecastHazardNotices(
            summary.forecast.data,
            now,
            reportDateKey,
            summary.spot.timezone
          )
        : []
    )
  );

  return (
    <>
      <section className="reportHero" aria-labelledby="daily-report-title">
        <p className="kicker">NorCal daily surf report</p>
        <h1 id="daily-report-title">{report.title}</h1>
        <p className="reportLead">{report.body}</p>
      </section>

      <section className="compareSection" aria-labelledby="compare-heading">
        <div className="sectionTitle compareSectionTitle">
          <h2 id="compare-heading">Compare spots</h2>
          <HazardNotice notices={hazards} />
        </div>
        <div className="compareList">
          <div className="compareHeader" aria-hidden="true">
            <span>Spot</span>
            <span>Size estimate</span>
            <span>Wind / surface</span>
            <span>Tide</span>
            <span>Best window</span>
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
                  <strong data-label="Size estimate">{surfHeightRange(row.window.waveHeightFt)}</strong>
                  <span data-label="Wind / surface">{windSnapshot(row.spot, row.window)}</span>
                  <span data-label="Tide">{formatNumber(row.window.tideFt, " ft", 1)} · {tideTrend(row.windows, row.window).toLowerCase()}</span>
                  <span data-label="Best window">{formatWindowSpan(
                    row.selection?.startAt ?? row.window.forecastAt,
                    row.spot.timezone,
                    row.selection?.endAt
                  )}</span>
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
  const displayReportDateKeys = useMemo(
    () => availableDisplayLocalDateKeys(spot, windows),
    [spot, windows]
  );
  const planningReportDateKeys = useMemo(
    () => availableLocalDateKeys(spot, windows, now, forecastData?.sunPhases),
    [forecastData?.sunPhases, now, spot, windows]
  );
  const defaultReportDateKey = planningReportDateKeys[0] ?? displayReportDateKeys[0] ?? null;
  const [selectedReportDateKey, setSelectedReportDateKey] = useState<string | null>(
    defaultReportDateKey
  );
  useEffect(() => {
    setSelectedReportDateKey((current) =>
      current && displayReportDateKeys.includes(current) ? current : defaultReportDateKey
    );
  }, [defaultReportDateKey, displayReportDateKeys, spot.id]);
  const selectReportDate = useCallback((date: string | null) => {
    setSelectedReportDateKey(
      date && displayReportDateKeys.includes(date) ? date : defaultReportDateKey
    );
  }, [defaultReportDateKey, displayReportDateKeys]);
  const reportDateKey = selectedReportDateKey ?? defaultReportDateKey;
  const daySelection = reportDateKey
    ? bestWindowSelection(
        spot,
        windows,
        now,
        reportDateKey,
        forecastData?.sunPhases,
        forecastData?.recommendations
      )
    : undefined;
  const dayBest = daySelection?.window;
  const current = windows
    .filter((window) => window.ratingStatus === "scored")
    .sort(
      (left, right) =>
        Math.abs(new Date(left.forecastAt).getTime() - now.getTime()) -
        Math.abs(new Date(right.forecastAt).getTime() - now.getTime())
    )[0];
  const featured = reportDateKey ? dayBest : current;
  const hazards = forecastData
    ? forecastHazardNotices(forecastData, now, reportDateKey, spot.timezone)
    : [];
  const activeSpotLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    activeSpotLinkRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [spot.id]);
  return (
    <>
      <nav className="spotNav" aria-label="Surf spots">
        <a className="backLink" href="/"><ArrowLeft size={17} aria-hidden="true" /> Daily report</a>
        <div className="spotLinks">
          {summaries.map((item) => (
            <a
              className={item.spot.id === spot.id ? "active" : undefined}
              href={forecastHref(item.spot.id)}
              key={item.spot.id}
              aria-current={item.spot.id === spot.id ? "page" : undefined}
              ref={item.spot.id === spot.id ? activeSpotLinkRef : undefined}
            >
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
              <strong>{formatDay(featured.forecastAt, spot.timezone, false)}:</strong> {surfHeightRange(featured.waveHeightFt)} surf with {surfaceCondition(spot, featured)} surface.
              {dayBest && <> Best window: <strong>{formatWindowSpan(
                daySelection?.startAt ?? dayBest.forecastAt,
                spot.timezone,
                daySelection?.endAt
              )}</strong>.</>}
            </p>
          ) : (
            <p className="spotCall">No reliable wave call yet. Wind and tide may still be available below.</p>
          )}
        </div>
      </section>

      <HazardNotice notices={hazards} />
      <div className="spotWorkbench">
        <ForecastWorkbench
          spot={spot}
          initialForecast={forecastData}
          initialError={forecast?.status === "error" ? forecast.error : null}
          now={now}
          onForecastRecovered={onForecastRecovered}
          onSelectedDateChange={selectReportDate}
        />
      </div>
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
          ? null
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
      [...state.spots].sort(sortSpotsByDisplayOrder).map((spot) => {
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
      <Header state={state} now={now} onRefresh={() => void loadDashboard()} />
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
