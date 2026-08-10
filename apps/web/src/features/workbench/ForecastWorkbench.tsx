import type { ApiSpot, ForecastResponse } from "@surf/contracts";
import { selectCanonicalRecommendationIds } from "@surf/forecast-core";
import {
  BookOpen,
  CloudOff,
  Database,
  Info,
  LineChart as LineChartIcon,
  Moon,
  Radio,
  TableProperties
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../../components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { InfoTooltip, TooltipProvider } from "../../components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { cardinalDirection, formatDay, formatWindowSpan, surfHeightRange } from "../../forecast-view";
import {
  adaptForecastResponse,
  availableWorkbenchDates,
  formatSwell,
  parseBriefResponse,
  readWorkbenchUrl,
  replaceWorkbenchUrl,
  sourceHealthForWindow,
  type DailyAnalysis,
  type ForecastInterval,
  type SpotTab,
  type WorkbenchForecast,
  type WorkbenchRecommendation,
  type WorkbenchView,
  type WorkbenchWindow
} from "./forecast-adapter";
import { expectedForecastSlotCount } from "./workbench-time";
import {
  isUsableForecastResponse,
  parseUsableForecastResponse
} from "./forecast-health";

const ForecastGraph = lazy(() => import("./ForecastGraph"));

type ForecastCache = Partial<Record<ForecastInterval, ForecastResponse>>;

function formatNumber(value: number | null, suffix: string, digits = 0): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}${suffix}`;
}

function formatModeledHeight(value: number | null): string {
  return value === null ? "Unavailable" : `${value.toFixed(1)} ft Hs`;
}

function formatSurfSize(window: WorkbenchWindow): string {
  return surfHeightRange(window.raw.waveHeightFt);
}

function formatFreshness(minutes: number | null): string {
  if (minutes === null) return "Age unavailable";
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m old`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h old`;
  return `${Math.round(minutes / (24 * 60))}d old`;
}

function formatTimestamp(value: string, timezone: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "time unavailable";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone
    }).format(timestamp);
  } catch {
    return "time unavailable";
  }
}

// Formats a local date key (YYYY-MM-DD) for display, or returns null when the
// key is not a real calendar date. Noon UTC keeps the day stable across every
// North American offset instead of shifting at midnight. The round-trip check
// matters because JS rolls impossible dates forward — "2026-02-31" would
// otherwise render as a confident "Tuesday, Mar 3" that nobody asked for.
function formatLocalDateKey(dateKey: string, timezone: string): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const parsed = new Date(`${dateKey}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: timezone
    }).format(parsed);
  } catch {
    return null;
  }
}

function formatClock(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone
  }).format(new Date(value));
}

export function bestCanonicalDayWindow(
  windows: WorkbenchWindow[],
  now: Date,
  dateKey?: string,
  recommendations: WorkbenchRecommendation[] | null = null
): WorkbenchWindow | undefined {
  const published = recommendations?.find(
    (recommendation) =>
      (!dateKey || recommendation.localDate === dateKey) &&
      new Date(recommendation.endAt).getTime() >= now.getTime()
  );
  if (published) return published.representative;
  if (recommendations !== null) return undefined;
  const candidates = dateKey
    ? windows.filter((window) => window.localDateKey === dateKey)
    : windows;
  const selectedId = selectCanonicalRecommendationIds(
    candidates.map((window) => ({
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
  return candidates.find((window) => window.forecastAt === selectedId);
}

export function displayedCanonicalWindow(
  canonical: WorkbenchWindow | undefined,
  displayed: WorkbenchWindow[],
  interval: ForecastInterval
): WorkbenchWindow | undefined {
  if (!canonical) return undefined;
  const exact = displayed.find((window) => window.forecastAt === canonical.forecastAt);
  if (exact) return exact;
  const canonicalTime = Date.parse(canonical.forecastAt);
  if (!Number.isFinite(canonicalTime)) return undefined;
  const sameDate = displayed
    .filter((window) => window.localDateKey === canonical.localDateKey)
    .sort((left, right) => left.forecastAt.localeCompare(right.forecastAt));
  return sameDate.find((window, index) => {
    const start = Date.parse(window.forecastAt);
    const next = sameDate[index + 1];
    const end = next
      ? Date.parse(next.forecastAt)
      : start + (interval === "1h" ? 1 : 3) * 60 * 60 * 1000;
    return Number.isFinite(start) && Number.isFinite(end) && start <= canonicalTime && canonicalTime < end;
  });
}

function DailyAnalysisCard({
  analysis,
  spot,
  busy
}: {
  analysis: Extract<DailyAnalysis, { status: "published" }>;
  spot: ApiSpot;
  busy: boolean;
}) {
  const { report } = analysis;
  const stamp = formatTimestamp(report.updatedAt, spot.timezone);
  return (
    <section className="dailyBrief" aria-labelledby="daily-analysis-heading" aria-busy={busy}>
      <span className="srOnly" role="status" aria-live="polite">
        Analysis updated. {report.headline}
      </span>
      <div className="dailyBriefBody">
        <div className="dailyBriefMeta">
          <p className="kicker">Analysis</p>
          <time dateTime={report.updatedAt}>Updated {stamp}</time>
        </div>
        <h2 id="daily-analysis-heading">{report.headline}</h2>
        <div className="dailyAnalysisParagraphs">
          {report.paragraphs.map((paragraph, index) => (
            <p key={`${report.revisionId}-${index}`}>{paragraph}</p>
          ))}
        </div>
      </div>
    </section>
  );
}

async function fetchForecast(spotId: string, interval: ForecastInterval, signal: AbortSignal): Promise<ForecastResponse> {
  const response = await fetch(`/api/forecast/${spotId}?interval=${interval}`, {
    headers: { Accept: "application/json" },
    signal
  });
  if (!response.ok) throw new Error(`${interval === "1h" ? "Hourly" : "Three-hour"} forecast returned ${response.status}`);
  return parseUsableForecastResponse(await response.json());
}

function ConditionBadge({ window }: { window: WorkbenchWindow }) {
  return <span className={`conditionPill ${window.condition}`}>{window.condition}</span>;
}

function LearningGuideContents() {
  return (
    <dl className="learningGuideList">
      <div><dt>Surf size estimate</dt><dd>The planning range is the number to scan first. It is derived deterministically from the modeled coastal wave input, not measured wave-face height.</dd></div>
      <div><dt>Modeled wave state</dt><dd>Nearshore significant wave height (Hs). It is not measured breaking wave-face height.</dd></div>
      <div><dt>Swell components</dt><dd>Directional partitions appear only when the public source explicitly provides them. Bulk CDIP state is not relabeled as primary swell.</dd></div>
      <div><dt>Wind relationship</dt><dd>Offshore, onshore, and cross-shore describe how wind meets this beach—not simply the compass direction.</dd></div>
      <div><dt>Tide trend</dt><dd>Rising and falling describe movement between official high and low events; the same swell can break differently as depth changes.</dd></div>
      <div><dt>Confidence</dt><dd>A deterministic read of availability, calibration, lead time, and source health. It is not a promise that conditions will match.</dd></div>
      <div><dt>Freshness</dt><dd>Age is shown per source and selected timestamp. One fresh feed cannot make every input fresh.</dd></div>
      <div><dt>Night windows</dt><dd>A moon marks a window outside daylight. Night rows stay visible as context but are excluded from the daylight recommendation.</dd></div>
    </dl>
  );
}

function ForecastLearningGuide() {
  const trigger = (
    <button className="learningGuideTrigger" type="button">
      <BookOpen size={15} aria-hidden="true" /> How to read this report
    </button>
  );
  return (
    <>
      <div className="learningGuideDesktop">
        <Popover>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent align="end" className="learningGuidePopover">
            <strong className="learningGuideTitle">Forecast field guide</strong>
            <p>Use these labels to keep modeled state, observations, and surf estimates separate.</p>
            <LearningGuideContents />
          </PopoverContent>
        </Popover>
      </div>
      <div className="learningGuideMobile">
        <Sheet>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent>
            <SheetTitle className="learningGuideTitle">Forecast field guide</SheetTitle>
            <SheetDescription>Use these labels to keep modeled state, observations, and surf estimates separate.</SheetDescription>
            <LearningGuideContents />
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

function DayPicker({
  dates,
  selectedDate,
  windows,
  recommendations,
  spot,
  now,
  onSelect
}: {
  dates: string[];
  selectedDate: string | null;
  windows: WorkbenchWindow[];
  recommendations: WorkbenchRecommendation[] | null;
  spot: ApiSpot;
  now: Date;
  onSelect: (date: string) => void;
}) {
  return (
    <div className="forecastDayPicker" aria-label="Forecast day">
      {dates.map((date) => {
        const rows = windows.filter((window) => window.localDateKey === date);
        const recommendation = recommendations?.find(
          (candidate) =>
            candidate.localDate === date &&
            new Date(candidate.endAt).getTime() >= now.getTime()
        );
        const best = bestCanonicalDayWindow(rows, now, date, recommendations);
        const first = rows[0];
        return (
          <button
            key={date}
            type="button"
            className={selectedDate === date ? "active" : undefined}
            aria-pressed={selectedDate === date}
            onClick={() => onSelect(date)}
          >
            <span>{first ? formatDay(first.forecastAt, spot.timezone) : date}</span>
            <strong>{best ? formatSurfSize(best) : "No call"}</strong>
            <small>{best ? `${recommendation
              ? formatWindowSpan(recommendation.startAt, spot.timezone, recommendation.endAt)
              : formatClock(best.forecastAt, spot.timezone)} · ${best.condition}`
              : recommendations !== null ? "No remaining window" : "Inputs incomplete"}</small>
          </button>
        );
      })}
    </div>
  );
}

function WaveCell({ window }: { window: WorkbenchWindow }) {
  return (
    <div className="tableMetric">
      <strong>{formatSurfSize(window)}</strong>
      <span>{formatModeledHeight(window.modeledHeightFt)} · {formatNumber(window.periodSec, "s")} {cardinalDirection(window.directionDeg)}</span>
    </div>
  );
}

function SwellCell({ window }: { window: WorkbenchWindow }) {
  if (window.swellComponents.length === 0) {
    return <span className="emptyMetric">{window.waveSemantics === "unavailable" ? "Swell unavailable" : "Bulk wave state only"}</span>;
  }
  return (
    <div className="swellStack">
      {window.swellComponents.slice(0, 2).map((component) => (
        <div key={component.label}>
          <small>{component.label}</small>
          <span>{formatSwell(component)}</span>
        </div>
      ))}
    </div>
  );
}

function WindCell({ window }: { window: WorkbenchWindow }) {
  if (window.windSpeedKt === null || window.windDirectionDeg === null) {
    return (
      <div className="tableMetric">
        <strong>Wind unavailable</strong>
      </div>
    );
  }
  return (
    <div className="tableMetric">
      <strong>{cardinalDirection(window.windDirectionDeg)} {formatNumber(window.windSpeedKt, " kt")}</strong>
      <span>{window.windGustKt === null ? window.windRelation : `Gust ${formatNumber(window.windGustKt, " kt")} · ${window.windRelation}`}</span>
    </div>
  );
}

function TideCell({ window }: { window: WorkbenchWindow }) {
  return (
    <div className="tableMetric">
      <strong>{formatNumber(window.tideFt, " ft", 1)}</strong>
      <span>{window.tideTrend}</span>
    </div>
  );
}

function WindowExpandedDetails({ window, spot }: { window: WorkbenchWindow; spot: ApiSpot }) {
  const validity = window.validFrom && window.validTo
    ? `Valid ${formatClock(window.validFrom, spot.timezone)}–${formatClock(window.validTo, spot.timezone)} · ${window.waveResolutionMethod}.`
    : "No valid modeled-wave interval is available.";
  return (
    <div className="windowExpandedDetails" aria-label={`Why ${formatClock(window.forecastAt, spot.timezone)} looks this way`}>
      <div>
        <span>What the wave number means</span>
        <strong>{window.waveSemanticsLabel}</strong>
        <p>{window.calibrationLabel}. {validity}</p>
      </div>
      <div>
        <span>Why this changes the call</span>
        <strong>{window.explanation}</strong>
        <p>{window.caveats[0] ?? "No additional deterministic caveat for this interval."}</p>
      </div>
      <div>
        <span>Data health</span>
        <strong>{window.confidenceLabel} confidence · {formatFreshness(window.sourceFreshnessMinutes)}</strong>
        <p>{window.weatherSummary ?? "Weather summary unavailable."}</p>
      </div>
      {!window.isDaylight && (
        <div>
          <span>Night window</span>
          <strong>Shown as context only</strong>
          <p>Rows marked with a moon fall outside daylight, so they stay visible but are excluded from the daylight recommendation.</p>
        </div>
      )}
    </div>
  );
}

function DesktopForecastTable({
  windows,
  selectedAt,
  expandedAt,
  spot,
  interval,
  onSelect,
  onToggleExpand
}: {
  windows: WorkbenchWindow[];
  selectedAt: string | null;
  expandedAt: string | null;
  spot: ApiSpot;
  interval: ForecastInterval;
  onSelect: (value: string) => void;
  onToggleExpand: (value: string | null) => void;
}) {
  return (
    <div className="forecastTableViewport">
      <table className="forecastTable">
        <caption className="srOnly">{interval === "1h" ? "One-hour" : "Three-hour"} surf-planning inputs for {spot.name}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span>Time <InfoTooltip label="What do the moon icons mean?">A moon marks a night window. Night rows stay visible as context but are excluded from the daylight recommendation.</InfoTooltip></span>
            </th>
            <th scope="col">
              <span>Surf size <InfoTooltip label="What does surf size mean?">A deterministic planning range derived from the modeled coastal wave input. The supporting Hs value below is not measured breaking wave-face height.</InfoTooltip></span>
            </th>
            <th scope="col">
              <span>Swell <InfoTooltip label="What are swell components?">Directional components appear only when the source explicitly resolves them.</InfoTooltip></span>
            </th>
            <th scope="col">
              <span>Wind <InfoTooltip label="Why does wind matter?">Wind direction relative to the beach helps determine whether the surface stays clean or becomes choppy.</InfoTooltip></span>
            </th>
            <th scope="col">
              <span>Tide <InfoTooltip label="Why does tide matter?">The same swell can break differently as water depth rises or falls over the spot.</InfoTooltip></span>
            </th>
            <th scope="col">Condition</th>
            <th scope="col">
              <span>Confidence <InfoTooltip label="What does confidence show?">Confidence combines input availability, freshness, lead time, and calibration status. Source details are available below the workbench.</InfoTooltip></span>
            </th>
          </tr>
        </thead>
        <tbody>
          {windows.map((window) => {
            const selected = selectedAt === window.forecastAt;
            const expanded = expandedAt === window.forecastAt;
            return [
              <tr
                className={`${window.isDaylight ? "" : "nightRow"}${selected ? " selectedRow" : ""}${window.dataHealth === "limited" ? " gapRow" : ""}`}
                key={window.forecastAt}
                data-testid={`forecast-row-${window.forecastAt}`}
              >
                <th scope="row">
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-expanded={expanded}
                    onClick={() => {
                      onSelect(window.forecastAt);
                      onToggleExpand(window.forecastAt);
                    }}
                  >
                    {!window.isDaylight && <Moon size={13} aria-label="Night window" role="img" />}
                    <span>{formatClock(window.forecastAt, spot.timezone)}</span>
                  </button>
                </th>
                <td><WaveCell window={window} /></td>
                <td><SwellCell window={window} /></td>
                <td><WindCell window={window} /></td>
                <td><TideCell window={window} /></td>
                <td><ConditionBadge window={window} /></td>
                <td><div className="trustCell"><strong>{window.confidenceLabel}</strong>{window.dataHealth === "limited" && <small>Limited inputs</small>}</div></td>
              </tr>,
              expanded ? (
                <tr className="selectedDetailRow" key={`${window.forecastAt}-details`}>
                  <td colSpan={7}><WindowExpandedDetails window={window} spot={spot} /></td>
                </tr>
              ) : null
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function MobileForecastRows({
  windows,
  selectedAt,
  expandedAt,
  spot,
  interval,
  onSelect,
  onToggleExpand
}: {
  windows: WorkbenchWindow[];
  selectedAt: string | null;
  expandedAt: string | null;
  spot: ApiSpot;
  interval: ForecastInterval;
  onSelect: (value: string) => void;
  onToggleExpand: (value: string | null) => void;
}) {
  return (
    <Accordion
      className="mobileForecastRows"
      type="single"
      collapsible
      value={expandedAt ?? ""}
      onValueChange={(value) => {
        onToggleExpand(value || null);
        if (value) onSelect(value);
      }}
      aria-label={`${interval === "1h" ? "One-hour" : "Three-hour"} surf-planning inputs for ${spot.name}`}
    >
      {windows.map((window) => (
        <AccordionItem
          className={`${window.isDaylight ? "" : "nightRow"}${selectedAt === window.forecastAt ? " selectedRow" : ""}${window.dataHealth === "limited" ? " gapRow" : ""}`}
          value={window.forecastAt}
          key={window.forecastAt}
        >
          <AccordionTrigger>
            <span className="mobileTime">{!window.isDaylight && <Moon size={13} aria-label="Night window" role="img" />}{formatClock(window.forecastAt, spot.timezone)}</span>
            <span className="mobileWave"><strong>{formatSurfSize(window)}</strong><small>{formatModeledHeight(window.modeledHeightFt)} · {formatNumber(window.periodSec, "s")} {cardinalDirection(window.directionDeg)}</small></span>
            <ConditionBadge window={window} />
          </AccordionTrigger>
          <AccordionContent>
            <dl className="mobileMetricGrid">
              <div><dt>Wave semantics</dt><dd>{window.waveSemanticsLabel}<small>{window.calibrationLabel}</small></dd></div>
              <div><dt>Wind</dt><dd><WindCell window={window} /></dd></div>
              <div><dt>Tide</dt><dd><TideCell window={window} /></dd></div>
              <div><dt>Confidence</dt><dd>{window.confidenceLabel}{window.dataHealth === "limited" ? " · limited inputs" : ""}</dd></div>
              <div className="mobileSwell"><dt>Swell components</dt><dd><SwellCell window={window} /></dd></div>
            </dl>
            <WindowExpandedDetails window={window} spot={spot} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function TideEvents({ forecast, selectedDate, spot }: { forecast: WorkbenchForecast; selectedDate: string | null; spot: ApiSpot }) {
  const events = forecast.tideEvents.filter((event) => {
    if (!selectedDate) return false;
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: spot.timezone
    }).format(new Date(event.at)) === selectedDate;
  });
  if (events.length === 0) return null;
  return (
    <div className="tideEventStrip" aria-label="High and low tide events">
      {events.map((event) => (
        <span key={`${event.type}-${event.at}`}><strong>{event.type === "high" ? "High" : "Low"}</strong>{formatClock(event.at, spot.timezone)} · {event.heightFt.toFixed(1)} ft</span>
      ))}
    </div>
  );
}

function DataHealthPanel({ forecast, selected, spot }: { forecast: WorkbenchForecast; selected?: WorkbenchWindow; spot: ApiSpot }) {
  const observation = forecast.observations[0];
  const selectedSources = selected ? sourceHealthForWindow(selected) : forecast.sourceHealth;
  const sourceStatusLabels = { fresh: "Fresh", stale: "Stale", missing: "Missing" } as const;
  return (
    <Accordion className="workbenchDisclosure" type="single" collapsible>
      <AccordionItem value="data-health">
        <AccordionTrigger>
          <span className="disclosureLabel"><Radio size={17} aria-hidden="true" /> Data, confidence &amp; provenance</span>
          <span>{selected ? `${selected.confidenceLabel} confidence · ${selected.waveSemanticsLabel}` : "No selected window"}</span>
        </AccordionTrigger>
        <AccordionContent>
          {selected && (
            <div className="sourceSummary">
              <div><span>Selected wave input</span><strong>{selected.waveSemanticsLabel}</strong><small>{selected.calibrationLabel}</small></div>
              <div>
                <span>Wave validity</span>
                <strong>{selected.validFrom && selected.validTo ? `${formatClock(selected.validFrom, spot.timezone)}–${formatClock(selected.validTo, spot.timezone)}` : "Unavailable"}</strong>
                <small>{selected.resolutionHours === null ? "No source resolution" : `${selected.resolutionHours}h source resolution · ${selected.waveResolutionMethod}`}</small>
              </div>
              <div><span>Displayed condition</span><strong>{selected.condition}</strong><small>Calculated from the selected wind input</small></div>
            </div>
          )}
          {selectedSources.length > 0 && (
            <div className="sourceHealthList" aria-live="polite" aria-label={selected ? `Sources for ${formatClock(selected.forecastAt, spot.timezone)}` : "Forecast sources"}>
              {selectedSources.map((source) => (
                <span key={source.id} className={source.status}>
                  <i aria-hidden="true" />
                  <strong>{source.label}</strong>
                  <em className="sourceStatus">{sourceStatusLabels[source.status]}</em>
                  <small>{formatFreshness(source.ageMinutes)}{source.issuedAt ? ` · source ${formatTimestamp(source.issuedAt, spot.timezone)}` : ""}</small>
                </span>
              ))}
            </div>
          )}
          {observation && (
            <p className="observationRead">
              <Database size={16} aria-hidden="true" /> Latest buoy observation: {observation.waveHeightFt.toFixed(1)} ft @ {formatNumber(observation.dominantPeriodSec ?? observation.averagePeriodSec, "s")} {cardinalDirection(observation.meanWaveDirectionDeg)} at {formatTimestamp(observation.observedAt, spot.timezone)}. This is context, not the modeled spot forecast.
            </p>
          )}
          {forecast.issueDelta && (
            <p className="issueDeltaRead">
              Forecast issue {formatTimestamp(forecast.issueDelta.currentIssuedAt, spot.timezone)} · {forecast.issueDelta.changedWindowCount} window{forecast.issueDelta.changedWindowCount === 1 ? "" : "s"} changed since the prior issue.
            </p>
          )}
          <p className="sourceNote">{forecast.sourceNote}</p>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function ForecastWorkbench({
  spot,
  initialForecast,
  initialError,
  now,
  onForecastRecovered,
  onSelectedDateChange
}: {
  spot: ApiSpot;
  initialForecast: ForecastResponse | null;
  initialError?: string | null;
  now: Date;
  onForecastRecovered?: (spotId: ApiSpot["id"], forecast: ForecastResponse) => void;
  onSelectedDateChange?: (date: string | null) => void;
}) {
  const initialUrl = useMemo(() => readWorkbenchUrl(window.location.search), [spot.id]);
  const [interval, setInterval] = useState<ForecastInterval>(initialUrl.interval);
  const [view, setView] = useState<WorkbenchView>(initialUrl.view);
  const [selectedDate, setSelectedDate] = useState<string | null>(initialUrl.date);
  const [selectedAt, setSelectedAt] = useState<string | null>(initialUrl.at);
  const [tab, setTab] = useState<SpotTab>(initialUrl.tab);
  const [expandedAt, setExpandedAt] = useState<string | null>(null);
  const [cache, setCache] = useState<ForecastCache>(() => (
    isUsableForecastResponse(initialForecast) ? { "3h": initialForecast } : {}
  ));
  const [intervalLoading, setIntervalLoading] = useState(initialUrl.interval === "1h");
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [intervalNotice, setIntervalNotice] = useState<string | null>(null);
  const fetchController = useRef<AbortController | null>(null);
  const cacheRef = useRef(cache);
  const hourlyFailurePending = useRef(false);
  const canonicalRecoveryState = useRef<"idle" | "pending" | "ready" | "failed">(
    isUsableForecastResponse(initialForecast) ? "ready" : "idle"
  );
  // The ref above drives fetch coordination, but the Analysis panel has to
  // render off this, and a ref that changes without setting state would leave
  // it waiting on a request that already gave up.
  const [, setCanonicalFailed] = useState(false);
  // Bumped whenever an external reset aborts the active interval's request,
  // so the interval effect reissues it instead of leaving it dead.
  const [reloadToken, setReloadToken] = useState(0);
  const explicitTimestampSelection = useRef(Boolean(initialUrl.at));
  const previousInitialForecast = useRef(initialForecast);

  useEffect(() => {
    onSelectedDateChange?.(selectedDate);
  }, [onSelectedDateChange, selectedDate]);

  useEffect(() => {
    if (previousInitialForecast.current === initialForecast) return;
    previousInitialForecast.current = initialForecast;
    if (!isUsableForecastResponse(initialForecast)) return;
    fetchController.current?.abort();
    const nextCache: ForecastCache = { "3h": initialForecast };
    cacheRef.current = nextCache;
    hourlyFailurePending.current = false;
    canonicalRecoveryState.current = "ready";
    setCache(nextCache);
    // This reset aborts whatever the active interval had in flight and drops
    // its cache entry. At hourly resolution none of the interval effect's other
    // deps move — the entry was already absent, so `activeIntervalForecast`
    // stays undefined — and the aborted request would never be reissued,
    // leaving a spinner that resolves only if the reader switches resolution
    // twice. Bumping a token the effect depends on makes the reissue automatic.
    setReloadToken((token) => token + 1);
  }, [initialForecast]);

  useEffect(() => {
    replaceWorkbenchUrl({ interval, view });
  }, [interval, view]);

  const activeIntervalForecast = cache[interval];

  useEffect(() => {
    if (activeIntervalForecast) {
      setIntervalLoading(false);
      setIntervalError(null);
      return;
    }
    fetchController.current?.abort();
    const controller = new AbortController();
    fetchController.current = controller;
    setIntervalLoading(true);
    setIntervalError(null);
    void fetchForecast(spot.id, interval, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setCache((current) => {
          const next = { ...current, [interval]: response };
          cacheRef.current = next;
          return next;
        });
        if (interval === "1h") hourlyFailurePending.current = false;
        if (interval === "3h") {
          canonicalRecoveryState.current = "ready";
          onForecastRecovered?.(spot.id, response);
        }
        setIntervalLoading(false);
        setIntervalNotice(null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (interval === "1h") {
          hourlyFailurePending.current = true;
        }
        if (interval === "1h" && cacheRef.current["3h"]) {
          hourlyFailurePending.current = false;
          setIntervalLoading(false);
          setInterval("3h");
          setSelectedAt(null);
          setIntervalError(null);
          setIntervalNotice("Hourly detail is temporarily unavailable. Showing the latest three-hour forecast.");
          replaceWorkbenchUrl({ interval: "3h", at: null });
          return;
        }
        if (interval === "1h") {
          if (canonicalRecoveryState.current === "failed") {
            hourlyFailurePending.current = false;
            setIntervalLoading(false);
            setIntervalError("Forecast detail is temporarily unavailable. Try refreshing in a moment");
            return;
          }
          setIntervalLoading(true);
          setIntervalError(null);
          return;
        }
        canonicalRecoveryState.current = "failed";
        setIntervalLoading(false);
        setIntervalError("Forecast detail is temporarily unavailable. Try refreshing in a moment");
      });
    return () => controller.abort();
  }, [activeIntervalForecast, interval, onForecastRecovered, reloadToken, spot.id]);

  const canonicalCacheEntry = cache["3h"];

  useEffect(() => {
    if (interval !== "1h" || canonicalCacheEntry) return;
    const controller = new AbortController();
    canonicalRecoveryState.current = "pending";
    setCanonicalFailed(false);
    void fetchForecast(spot.id, "3h", controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          canonicalRecoveryState.current = "ready";
          setCache((current) => {
            const next = { ...current, "3h": response };
            cacheRef.current = next;
            return next;
          });
          onForecastRecovered?.(spot.id, response);
          if (hourlyFailurePending.current) {
            hourlyFailurePending.current = false;
            setIntervalLoading(false);
            setInterval("3h");
            setSelectedAt(null);
            setIntervalError(null);
            setIntervalNotice("Hourly detail is temporarily unavailable. Showing the latest three-hour forecast.");
            replaceWorkbenchUrl({ interval: "3h", at: null });
          }
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        canonicalRecoveryState.current = "failed";
        setCanonicalFailed(true);
        if (hourlyFailurePending.current) {
          hourlyFailurePending.current = false;
          setIntervalLoading(false);
          setIntervalError("Forecast detail is temporarily unavailable. Try refreshing in a moment");
        }
      });
    return () => controller.abort();
  }, [canonicalCacheEntry, interval, onForecastRecovered, spot.id]);

  const rawForecast = cache[interval];
  const forecast = useMemo(
    () => rawForecast ? adaptForecastResponse(rawForecast, spot, interval) : null,
    [interval, rawForecast, spot]
  );
  const canonicalForecast = useMemo(
    () => cache["3h"] ? adaptForecastResponse(cache["3h"], spot, "3h") : null,
    [cache, spot]
  );
  const dates = useMemo(() => forecast ? availableWorkbenchDates(forecast.windows) : [], [forecast]);

  useEffect(() => {
    if (dates.length === 0) return;
    if (selectedDate && dates.includes(selectedDate)) return;
    const canonicalWindows = canonicalForecast?.windows ?? [];
    const nextDate = dates.find((date) =>
      bestCanonicalDayWindow(
        canonicalWindows,
        now,
        date,
        canonicalForecast?.recommendations
      )
    ) ?? dates[0]!;
    setSelectedDate(nextDate);
    setSelectedAt(null);
    explicitTimestampSelection.current = false;
    replaceWorkbenchUrl({ date: nextDate, at: null });
  }, [canonicalForecast, dates, now, selectedDate]);

  const dayWindows = useMemo(
    () => forecast?.windows.filter((window) => window.localDateKey === selectedDate) ?? [],
    [forecast, selectedDate]
  );
  const canonicalDayBest = useMemo(
    () => bestCanonicalDayWindow(
      canonicalForecast?.windows ?? [],
      now,
      selectedDate ?? undefined,
      canonicalForecast?.recommendations
    ),
    [canonicalForecast, now, selectedDate]
  );
  const dayBest = useMemo(
    () => displayedCanonicalWindow(canonicalDayBest, dayWindows, interval),
    [canonicalDayBest, dayWindows, interval]
  );

  useEffect(() => {
    if (dayWindows.length === 0) return;
    if (
      explicitTimestampSelection.current &&
      selectedAt &&
      dayWindows.some((window) => window.forecastAt === selectedAt)
    ) return;
    const next = dayBest ?? dayWindows.find((window) => window.isDaylight) ?? dayWindows[0]!;
    if (selectedAt === next.forecastAt) return;
    setSelectedAt(next.forecastAt);
    replaceWorkbenchUrl({ at: next.forecastAt });
  }, [dayBest, dayWindows, selectedAt]);

  const selected = dayWindows.find((window) => window.forecastAt === selectedAt) ?? dayBest ?? dayWindows[0];

  const selectDate = useCallback((date: string) => {
    explicitTimestampSelection.current = false;
    setSelectedDate(date);
    setSelectedAt(null);
    setExpandedAt(null);
    replaceWorkbenchUrl({ date, at: null });
  }, []);

  const selectAt = useCallback((at: string) => {
    explicitTimestampSelection.current = true;
    setSelectedAt(at);
    replaceWorkbenchUrl({ at });
  }, []);

  const changeInterval = useCallback((value: string) => {
    if (value !== "1h" && value !== "3h") return;
    explicitTimestampSelection.current = false;
    hourlyFailurePending.current = false;
    setInterval(value);
    setIntervalNotice(null);
    setIntervalError(null);
    setSelectedAt(null);
    setExpandedAt(null);
    replaceWorkbenchUrl({ interval: value, at: null });
  }, []);

  const changeView = useCallback((value: string) => {
    if (value !== "table" && value !== "graph") return;
    setView(value);
    replaceWorkbenchUrl({ view: value });
  }, []);

  const changeTab = useCallback((value: string) => {
    if (value !== "forecast" && value !== "analysis") return;
    setTab(value);
    // The default tab stays out of the URL so existing deep links keep their
    // exact shape; only the Analysis selection is serialized.
    replaceWorkbenchUrl({ tab: value === "analysis" ? "analysis" : null });
  }, []);

  const toggleExpandedAt = useCallback((value: string | null) => {
    setExpandedAt((current) => (value === null || current === value ? null : value));
  }, []);

  const expectedRows = selectedDate
    ? expectedForecastSlotCount(selectedDate, interval, spot.timezone)
    : interval === "1h" ? 24 : 8;
  const coveredRows = dayWindows.length;
  const hasCoverageGap = expectedRows > 0 && coveredRows < expectedRows;

  return (
    <TooltipProvider delayDuration={180}>
      {forecast && dates.length > 0 && (
        <DayPicker
          dates={dates}
          selectedDate={selectedDate}
          windows={canonicalForecast?.windows ?? []}
          recommendations={canonicalForecast?.recommendations ?? null}
          spot={spot}
          now={now}
          onSelect={selectDate}
        />
      )}
      <Tabs value={tab} onValueChange={changeTab} className="spotViewTabs">
        <TabsList aria-label="Spot view" className="spotViewTabsList">
          <TabsTrigger value="forecast">Forecast</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
        </TabsList>

        <TabsContent value="forecast">
      <section className="workbenchSection" aria-label="Forecast workbench">
        <Tabs value={view} onValueChange={changeView} className="workbenchTabs">
          <div className="workbenchControls">
            <TabsList aria-label="Forecast view">
              <TabsTrigger value="table"><TableProperties size={15} aria-hidden="true" /> Table</TabsTrigger>
              <TabsTrigger value="graph"><LineChartIcon size={15} aria-hidden="true" /> Graph</TabsTrigger>
            </TabsList>
            <div className="intervalControl">
              <span>Resolution</span>
              <ToggleGroup type="single" value={interval} onValueChange={changeInterval} aria-label="Forecast resolution">
                <ToggleGroupItem value="1h" aria-label="One-hour resolution">1 hour</ToggleGroupItem>
                <ToggleGroupItem value="3h" aria-label="Three-hour resolution">3 hours</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          {intervalError && (
            <div className="workbenchError" role="alert"><Info size={17} aria-hidden="true" /><span>{intervalError}.</span></div>
          )}
          {intervalNotice && (
            <div className="coverageNotice" role="status"><Info size={17} aria-hidden="true" /><span>{intervalNotice}</span></div>
          )}
          {initialError && !rawForecast && !intervalError && (
            <div className="workbenchError" role="alert"><Info size={17} aria-hidden="true" /><span>Forecast detail is temporarily unavailable. Try refreshing in a moment.</span></div>
          )}
          {initialError && rawForecast && (
            <span className="srOnly" role="status" aria-live="polite">Forecast detail recovered after the initial request failed.</span>
          )}
          {intervalLoading ? (
            <div className="workbenchSkeleton" role="status" aria-live="polite" aria-label="Loading forecast detail">
              <span className="srOnly">Loading forecast detail.</span>
              <Skeleton className="skeletonToolbar" />
              {Array.from({ length: 6 }, (_, index) => <Skeleton className="skeletonRow" key={index} />)}
            </div>
          ) : dayWindows.length === 0 ? (
            <div className="workbenchEmpty" role="status"><CloudOff size={20} aria-hidden="true" /><span>No forecast detail is available for this day.</span></div>
          ) : (
            <>
              {hasCoverageGap && (
                <div className="coverageNotice" role="status"><Info size={15} aria-hidden="true" /> {coveredRows} of {expectedRows} expected {interval} windows are available. Gaps remain visible and are not filled.</div>
              )}
              <TabsContent value="table">
                {interval === "1h" && dayWindows.some((window) => window.waveResolutionMethod === "held") && (
                  <p className="sourceValidityNote">Hourly rows follow the latest source interval. Expand a row for its exact validity.</p>
                )}
                <DesktopForecastTable windows={dayWindows} selectedAt={selectedAt} expandedAt={expandedAt} spot={spot} interval={interval} onSelect={selectAt} onToggleExpand={toggleExpandedAt} />
                <MobileForecastRows windows={dayWindows} selectedAt={selectedAt} expandedAt={expandedAt} spot={spot} interval={interval} onSelect={selectAt} onToggleExpand={toggleExpandedAt} />
              </TabsContent>
              <TabsContent value="graph">
                <Suspense fallback={<div className="graphLoading" role="status" aria-live="polite" aria-label="Loading forecast graphs"><span className="srOnly">Loading forecast graphs.</span><Skeleton /></div>}>
                  <ForecastGraph
                    windows={dayWindows}
                    interval={interval}
                    tideEvents={forecast?.tideEvents ?? []}
                    selectedAt={selectedAt}
                    civilLight={forecast?.sunPhases.find((phase) => phase.localDate === selectedDate) ?? null}
                    spot={spot}
                    onSelect={selectAt}
                  />
                </Suspense>
              </TabsContent>
            </>
          )}
        </Tabs>

        {forecast && <TideEvents forecast={forecast} selectedDate={selectedDate} spot={spot} />}
      </section>
        </TabsContent>

        <TabsContent value="analysis">
          <AnalysisPanel
            spot={spot}
            selectedDate={selectedDate}
            canonicalGeneratedAt={canonicalForecast?.generatedAt ?? null}
          />
        </TabsContent>
      </Tabs>
      {(forecast ?? canonicalForecast) && (
        <DataHealthPanel
          forecast={(forecast ?? canonicalForecast)!}
          selected={selected}
          spot={spot}
        />
      )}
    </TooltipProvider>
  );
}

// Analysis owns the model-authored note and its request lifecycle. Forecast
// rendering remains independent: every non-published state is explicit and no
// deterministic prose is promoted into this surface.
function AnalysisPanel({
  spot,
  selectedDate,
  canonicalGeneratedAt
}: {
  spot: ApiSpot;
  selectedDate: string | null;
  canonicalGeneratedAt: string | null;
}) {
  const dayLabel = selectedDate ? formatLocalDateKey(selectedDate, spot.timezone) : null;
  return (
    <div className="analysisPanel">
      {dayLabel && <p className="analysisDayLabel">Analysis for {dayLabel}</p>}
      <DailyAnalysis
        key={`${spot.id}:${selectedDate ?? "none"}`}
        spot={spot}
        selectedDate={selectedDate}
        canonicalGeneratedAt={canonicalGeneratedAt}
      />
      <div className="analysisTools">
        <ForecastLearningGuide />
      </div>
    </div>
  );
}

type AnalysisRequestState =
  | { status: "loading" }
  | { status: "settled"; analysis: DailyAnalysis }
  | { status: "failed" };

const ANALYSIS_PENDING_FAST_POLL_MS = 3_000;
const ANALYSIS_PENDING_FAST_REQUESTS = 20;
const ANALYSIS_PENDING_SLOW_POLL_MS = 30_000;
const ANALYSIS_PENDING_POLL_MAX_MS = 40 * 60_000;

function unavailableLine(busy: boolean) {
  return (
    <div className="quietBriefLine" role="status" aria-busy={busy}>
      <strong>Analysis unavailable</strong>
      <span>No validated report is available for this forecast.</span>
    </div>
  );
}

function DailyAnalysis({
  spot,
  selectedDate,
  canonicalGeneratedAt
}: {
  spot: ApiSpot;
  selectedDate: string | null;
  canonicalGeneratedAt: string | null;
}) {
  const [state, setState] = useState<AnalysisRequestState>({ status: "loading" });
  const [busy, setBusy] = useState(Boolean(selectedDate));
  const [pollingExhausted, setPollingExhausted] = useState(false);
  const [refreshCycle, setRefreshCycle] = useState(0);

  useEffect(() => {
    if (!selectedDate) {
      setBusy(false);
      setPollingExhausted(false);
      setState({ status: "failed" });
      return;
    }
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const pollingStartedAt = Date.now();
    // A canonical refresh may change exact code-owned values even when broad
    // condition bands are unchanged. Clear the old report until the Worker
    // proves it still matches the current fact fingerprint.
    setState({ status: "loading" });
    setBusy(true);
    setPollingExhausted(false);
    const requestAnalysis = async (requestNumber: number): Promise<void> => {
      try {
        const response = await fetch(
          `/api/forecast/${spot.id}/brief?date=${encodeURIComponent(selectedDate)}`,
          {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal
          }
        );
        if (!response.ok) throw new Error(`Analysis returned ${response.status}`);
        const analysis = parseBriefResponse(await response.json());
        if (!analysis) throw new Error("Analysis response was malformed");
        if (controller.signal.aborted) return;
        if (analysis.status === "pending") {
          setState({ status: "settled", analysis });
          const elapsedMs = Date.now() - pollingStartedAt;
          if (elapsedMs >= ANALYSIS_PENDING_POLL_MAX_MS) {
            setBusy(false);
            setPollingExhausted(true);
            return;
          }
          setBusy(true);
          setPollingExhausted(false);
          const intervalMs =
            requestNumber < ANALYSIS_PENDING_FAST_REQUESTS
              ? ANALYSIS_PENDING_FAST_POLL_MS
              : ANALYSIS_PENDING_SLOW_POLL_MS;
          const delayMs = Math.min(
            intervalMs,
            ANALYSIS_PENDING_POLL_MAX_MS - elapsedMs
          );
          pollTimer = setTimeout(() => {
            pollTimer = null;
            void requestAnalysis(requestNumber + 1);
          }, delayMs);
          return;
        }
        setState({ status: "settled", analysis });
        setBusy(false);
        setPollingExhausted(false);
      } catch {
        if (controller.signal.aborted) return;
        setBusy(false);
        setPollingExhausted(false);
        setState({ status: "failed" });
      }
    };
    void requestAnalysis(1);
    return () => {
      controller.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, [canonicalGeneratedAt, refreshCycle, selectedDate, spot.id]);

  if (state.status === "loading") {
    return (
      <p className="quietBriefLine" role="status" aria-busy="true">
        Loading Analysis…
      </p>
    );
  }
  if (state.status === "failed") return unavailableLine(busy);
  if (state.analysis.status === "published") {
    return <DailyAnalysisCard analysis={state.analysis} spot={spot} busy={busy} />;
  }
  if (state.analysis.status === "pending") {
    return (
      <div className="quietBriefLine" role="status" aria-busy={busy}>
        <span>{state.analysis.message}</span>
        {pollingExhausted && (
          <>
            <span>Automatic checks are paused, but the queued Analysis may still publish.</span>
            <button
              className="analysisRetryButton"
              type="button"
              onClick={() => setRefreshCycle((cycle) => cycle + 1)}
            >
              Check again
            </button>
          </>
        )}
      </div>
    );
  }
  return unavailableLine(busy);
}
