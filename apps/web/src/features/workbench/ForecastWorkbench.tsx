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
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import { Badge } from "../../components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Skeleton } from "../../components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "../../components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { InfoTooltip, TooltipProvider } from "../../components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { cardinalDirection, formatDay, localDateParts } from "../../forecast-view";
import {
  adaptForecastResponse,
  availableWorkbenchDates,
  formatSwell,
  parseBriefResponse,
  readWorkbenchUrl,
  replaceWorkbenchUrl,
  sourceHealthForWindow,
  type DailyBrief,
  type ForecastInterval,
  type SpotTab,
  type WorkbenchForecast,
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

function presentBriefCopy(value: string): string {
  const copy = value
    .replace(/\bdeterministic engine\b/gi, "forecast")
    .replace(/\bdeterministic condition score\b/gi, "condition score")
    .replace(/\bdeterministic daylight recommendation\b/gi, "daylight outlook")
    .replace(/\bdeterministic read\b/gi, "forecast read")
    .replace(/\bdeterministic\b\s*/gi, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return copy || "Forecast update";
}

function bestCanonicalDayWindow(
  windows: WorkbenchWindow[],
  now: Date,
  dateKey?: string
): WorkbenchWindow | undefined {
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

function displayedCanonicalWindow(
  canonical: WorkbenchWindow | undefined,
  displayed: WorkbenchWindow[]
): WorkbenchWindow | undefined {
  if (!canonical) return undefined;
  return displayed.find((window) => window.forecastAt === canonical.forecastAt) ??
    displayed.find((window) => {
      if (!window.validFrom || !window.validTo) return false;
      const canonicalTime = new Date(canonical.forecastAt).getTime();
      return (
        new Date(window.validFrom).getTime() <= canonicalTime &&
        canonicalTime < new Date(window.validTo).getTime()
      );
    });
}

function deterministicBrief(
  spot: ApiSpot,
  dateKey: string | null,
  best: WorkbenchWindow | undefined,
  generatedAt: string | null
): DailyBrief {
  if (!dateKey || !best) {
    return {
      status: "deterministic_fallback",
      provider: "deterministic",
      fallbackReason: null,
      availableRevisions: null,
      headline: "No reliable daylight recommendation yet",
      setup: "The workbench still shows every available public input. Missing wave data is left blank rather than inferred.",
      picks: [],
      bustFactors: ["The underlying coastal inputs may be incomplete or outside their useful freshness window."],
      lesson: {
        topic: "Data gaps",
        text: "A blank is useful information: it means the app does not have enough supported data to make that part of the call."
      },
      revision: null,
      generatedAt
    };
  }
  return {
    status: "deterministic_fallback",
    provider: "deterministic",
    fallbackReason: null,
    availableRevisions: null,
    headline: `${formatClock(best.forecastAt, spot.timezone)} is the leading daylight window`,
    setup: `${formatModeledHeight(best.modeledHeightFt)} with ${best.condition} surface, ${best.windRelation.toLowerCase()} wind, and ${best.confidenceLabel.toLowerCase()} confidence.`,
    picks: [{
      windowId: best.forecastAt,
      label: formatClock(best.forecastAt, spot.timezone),
      why: best.explanation,
      tradeoff: best.caveats[0] ?? `The wave value is ${best.waveSemanticsLabel.toLowerCase()}, not measured breaking wave-face height.`
    }],
    bustFactors: best.caveats.slice(0, 2),
    lesson: {
      topic: "Significant wave height",
      text: "Hs describes modeled wave energy near the coast. It is not automatically the height of the breaking wave you will surf."
    },
    revision: null,
    generatedAt
  };
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

function HealthBadge({ window }: { window: WorkbenchWindow }) {
  const labels = { good: "Healthy", watch: "Check source", limited: "Limited" };
  return <Badge className={`healthBadge ${window.dataHealth}`}>{labels[window.dataHealth]}</Badge>;
}

function LearningGuideContents() {
  return (
    <dl className="learningGuideList">
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

function DailyBriefCard({ brief, loading, spot }: { brief: DailyBrief; loading: boolean; spot: ApiSpot }) {
  const [bestPick, ...alternatePicks] = brief.picks;
  return (
    <section className="dailyBrief" aria-labelledby="daily-brief-heading" aria-busy={loading}>
      <span className="srOnly" role="status" aria-live="polite">
        {loading ? "Updating the daily outlook." : "Daily outlook updated."}
      </span>
      <div className="dailyBriefBody">
        <div className="dailyBriefMeta">
          <p className="kicker">Daily outlook</p>
          {brief.generatedAt && (
            <time dateTime={brief.generatedAt}>Outlook updated {formatTimestamp(brief.generatedAt, spot.timezone)}</time>
          )}
        </div>
        <h2 id="daily-brief-heading">{presentBriefCopy(brief.headline)}</h2>
        <p className="dailyBriefSetup">{presentBriefCopy(brief.setup)}</p>
        {bestPick && (
          <div className="briefRecommendations">
            <article className="briefPrimaryPick">
              <p className="briefSectionLabel">Best window</p>
              <h3>{bestPick.label ?? "Recommended window"}</h3>
              <dl className="briefPickDetails">
                <div>
                  <dt>Why</dt>
                  <dd>{presentBriefCopy(bestPick.why)}</dd>
                </div>
                {bestPick.tradeoff && (
                  <div>
                    <dt>Watch for</dt>
                    <dd>{presentBriefCopy(bestPick.tradeoff)}</dd>
                  </div>
                )}
              </dl>
            </article>
            {alternatePicks.length > 0 && (
              <div className="briefAlternateList" aria-label="Other worthwhile forecast windows">
                <p className="briefSectionLabel">Also worth a look</p>
                {alternatePicks.map((pick, index) => (
                  <article className="briefAlternatePick" key={`${pick.windowId ?? "pick"}-${index}`}>
                    <h3>{pick.label ?? `Option ${index + 2}`}</h3>
                    <dl className="briefPickDetails">
                      <div>
                        <dt>Why</dt>
                        <dd>{presentBriefCopy(pick.why)}</dd>
                      </div>
                      {pick.tradeoff && (
                        <div>
                          <dt>Watch for</dt>
                          <dd>{presentBriefCopy(pick.tradeoff)}</dd>
                        </div>
                      )}
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}
        {(brief.lesson || brief.bustFactors.length > 0) && (
          <div className="briefFooter">
            {brief.lesson && (
              <details className="lessonCallout">
                <summary>
                  <span>What this teaches you</span>
                  {brief.lesson.topic && <small>{presentBriefCopy(brief.lesson.topic)}</small>}
                </summary>
                <p>{presentBriefCopy(brief.lesson.text)}</p>
              </details>
            )}
            {brief.bustFactors.length > 0 && (
              <details className="bustFactors">
                <summary>What could change the call</summary>
                <ul>{brief.bustFactors.map((factor, index) => <li key={`${factor}-${index}`}>{presentBriefCopy(factor)}</li>)}</ul>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

class DailyBriefErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function DailyBriefRecoveryCard({ brief }: { brief: DailyBrief }) {
  return (
    <section className="dailyBrief" aria-labelledby="daily-brief-recovery-heading">
      <div className="dailyBriefBody">
        <div className="dailyBriefMeta"><p className="kicker">Daily outlook</p></div>
        <h2 id="daily-brief-recovery-heading">{presentBriefCopy(brief.headline)}</h2>
        <p className="dailyBriefSetup">{presentBriefCopy(brief.setup)}</p>
      </div>
    </section>
  );
}

function DayPicker({
  dates,
  selectedDate,
  windows,
  spot,
  now,
  onSelect
}: {
  dates: string[];
  selectedDate: string | null;
  windows: WorkbenchWindow[];
  spot: ApiSpot;
  now: Date;
  onSelect: (date: string) => void;
}) {
  return (
    <div className="forecastDayPicker" aria-label="Forecast day">
      {dates.map((date) => {
        const rows = windows.filter((window) => window.localDateKey === date);
        const best = bestCanonicalDayWindow(rows, now);
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
            <strong>{best ? formatModeledHeight(best.modeledHeightFt).replace(" Hs", "") : "No call"}</strong>
            <small>{best ? `${formatClock(best.forecastAt, spot.timezone)} · ${best.condition}` : "Inputs incomplete"}</small>
          </button>
        );
      })}
    </div>
  );
}

function WaveCell({ window, spot }: { window: WorkbenchWindow; spot: ApiSpot }) {
  const resolutionNote = window.waveResolutionMethod === "unavailable"
    ? "Wave input unavailable"
    : window.waveResolutionMethod === "held" && window.validFrom
      ? `Held from ${formatClock(window.validFrom, spot.timezone)} source interval`
      : window.waveResolutionMethod === "aggregated"
        ? "Aggregated across this display interval"
        : null;
  return (
    <div className="tableMetric">
      <strong>{formatModeledHeight(window.modeledHeightFt)}</strong>
      <span>{formatNumber(window.periodSec, "s")} · {cardinalDirection(window.directionDeg)}</span>
      {resolutionNote && <small>{resolutionNote}</small>}
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
        <span key={component.label}><small>{component.label}</small>{formatSwell(component)}</span>
      ))}
    </div>
  );
}

function WindCell({ window }: { window: WorkbenchWindow }) {
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
              <span>Modeled wave <InfoTooltip label="What does modeled wave mean?">Nearshore significant wave height (Hs), not measured breaking wave-face height.</InfoTooltip></span>
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
              <span>Trust <InfoTooltip label="What does trust show?">Confidence combines input availability, freshness, lead time, and calibration status.</InfoTooltip></span>
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
                <td><WaveCell window={window} spot={spot} /></td>
                <td><SwellCell window={window} /></td>
                <td><WindCell window={window} /></td>
                <td><TideCell window={window} /></td>
                <td><ConditionBadge window={window} /></td>
                <td><div className="trustCell"><strong>{window.confidenceLabel}</strong><HealthBadge window={window} /></div></td>
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
            <span className="mobileWave"><strong>{formatModeledHeight(window.modeledHeightFt)}</strong><small>{formatNumber(window.periodSec, "s")} · {cardinalDirection(window.directionDeg)}</small></span>
            <ConditionBadge window={window} />
          </AccordionTrigger>
          <AccordionContent>
            <dl className="mobileMetricGrid">
              <div><dt>Wave semantics</dt><dd>{window.waveSemanticsLabel}<small>{window.calibrationLabel}</small></dd></div>
              <div><dt>Wind</dt><dd><WindCell window={window} /></dd></div>
              <div><dt>Tide</dt><dd><TideCell window={window} /></dd></div>
              <div><dt>Trust</dt><dd>{window.confidenceLabel} · <HealthBadge window={window} /></dd></div>
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
  onForecastRecovered
}: {
  spot: ApiSpot;
  initialForecast: ForecastResponse | null;
  initialError?: string | null;
  now: Date;
  onForecastRecovered?: (spotId: ApiSpot["id"], forecast: ForecastResponse) => void;
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
  const explicitTimestampSelection = useRef(Boolean(initialUrl.at));
  const previousInitialForecast = useRef(initialForecast);

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
  }, [activeIntervalForecast, interval, onForecastRecovered, spot.id]);

  const canonicalCacheEntry = cache["3h"];

  useEffect(() => {
    if (interval !== "1h" || canonicalCacheEntry) return;
    const controller = new AbortController();
    canonicalRecoveryState.current = "pending";
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
      bestCanonicalDayWindow(canonicalWindows, now, date)
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
    () => bestCanonicalDayWindow(canonicalForecast?.windows ?? [], now, selectedDate ?? undefined),
    [canonicalForecast, now, selectedDate]
  );
  const dayBest = useMemo(
    () => displayedCanonicalWindow(canonicalDayBest, dayWindows),
    [canonicalDayBest, dayWindows]
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

  const currentDateKey = localDateParts(now, spot.timezone).key;
  const coverageFloor = selectedDate === currentDateKey
    ? now.getTime()
    : undefined;
  const expectedRows = selectedDate
    ? expectedForecastSlotCount(selectedDate, interval, spot.timezone, coverageFloor)
    : interval === "1h" ? 24 : 8;
  const coveredRows = coverageFloor === undefined
    ? dayWindows.length
    : dayWindows.filter((window) => new Date(window.forecastAt).getTime() >= coverageFloor).length;
  const hasCoverageGap = expectedRows > 0 && coveredRows < expectedRows;

  return (
    <TooltipProvider delayDuration={180}>
      <Tabs value={tab} onValueChange={changeTab} className="spotViewTabs">
        <TabsList aria-label="Spot view" className="spotViewTabsList">
          <TabsTrigger value="forecast">Forecast</TabsTrigger>
          <TabsTrigger value="analysis">Analysis</TabsTrigger>
        </TabsList>

        <TabsContent value="forecast">
      <section className="workbenchSection" aria-label="Forecast workbench">
        {forecast && dates.length > 0 && (
          <DayPicker dates={dates} selectedDate={selectedDate} windows={canonicalForecast?.windows ?? []} spot={spot} now={now} onSelect={selectDate} />
        )}

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
                <DesktopForecastTable windows={dayWindows} selectedAt={selectedAt} expandedAt={expandedAt} spot={spot} interval={interval} onSelect={selectAt} onToggleExpand={toggleExpandedAt} />
                <MobileForecastRows windows={dayWindows} selectedAt={selectedAt} expandedAt={expandedAt} spot={spot} interval={interval} onSelect={selectAt} onToggleExpand={toggleExpandedAt} />
              </TabsContent>
              <TabsContent value="graph">
                <Suspense fallback={<div className="graphLoading" role="status" aria-live="polite" aria-label="Loading forecast graphs"><span className="srOnly">Loading forecast graphs.</span><Skeleton /></div>}>
                  <ForecastGraph windows={dayWindows} interval={interval} tideEvents={forecast?.tideEvents ?? []} selectedAt={selectedAt} spot={spot} onSelect={selectAt} />
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
            canonicalDayBest={canonicalDayBest}
            canonicalGeneratedAt={canonicalForecast?.generatedAt ?? null}
            forecast={forecast}
            forecastErrored={Boolean(intervalError || (initialError && !rawForecast))}
            selected={selected}
          />
        </TabsContent>
      </Tabs>
    </TooltipProvider>
  );
}

// Analysis owns the Daily Forecaster prose, the learning guide, and the
// provenance accordion. It also owns the brief request lifecycle: the fetch
// can only begin once this panel mounts, i.e. when the Analysis tab is
// selected — the Forecast tab issues no /brief requests.
function AnalysisPanel({
  spot,
  selectedDate,
  canonicalDayBest,
  canonicalGeneratedAt,
  forecast,
  forecastErrored,
  selected
}: {
  spot: ApiSpot;
  selectedDate: string | null;
  canonicalDayBest: WorkbenchWindow | null | undefined;
  canonicalGeneratedAt: string | null;
  forecast: WorkbenchForecast | null;
  forecastErrored: boolean;
  selected?: WorkbenchWindow;
}) {
  const [serverBrief, setServerBrief] = useState<DailyBrief | null>(null);
  // A mount with a date already selected has a request coming, so the first
  // committed paint must not be a recommendation denial issued before the
  // Worker was even asked.
  const [briefLoading, setBriefLoading] = useState(() => Boolean(selectedDate));
  const fallbackBrief = useMemo(
    () => deterministicBrief(spot, selectedDate, canonicalDayBest ?? undefined, canonicalGeneratedAt),
    [canonicalDayBest, canonicalGeneratedAt, selectedDate, spot]
  );
  // The brief is scoped to a spot and a date; the payload generation only
  // decides when to re-ask. Discarding the current brief is therefore correct
  // when the scope changes and wrong when a refresh merely advances the
  // generation — that would blank a published outlook mid-read.
  const briefScope = `${spot.id}:${selectedDate ?? "none"}`;
  const loadedScope = useRef<string | null>(null);

  // The request is gated only on the selected date and the payload generation
  // (and on this panel being mounted, i.e. Analysis selected). A published
  // outlook must stay reachable for any date that has one — including a day
  // whose daylight windows have merely elapsed, where the local fallback has
  // no pick but the Worker's brief and its caveats still exist. Keying on the
  // canonical generation (a stable string) means a refresh that advances the
  // payload also picks up a newer brief revision while this tab stays open,
  // without the identity churn a memo object in the deps would cause.
  useEffect(() => {
    if (!selectedDate) return;
    const controller = new AbortController();
    if (loadedScope.current !== briefScope) {
      setServerBrief(null);
      loadedScope.current = briefScope;
    }
    setBriefLoading(true);
    void fetch(`/api/forecast/${spot.id}/brief?date=${encodeURIComponent(selectedDate)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return parseBriefResponse(await response.json());
      })
      .then((value) => {
        if (controller.signal.aborted) return;
        // Replace only on success: a refresh whose brief request fails keeps
        // the published outlook it already had rather than erasing it.
        if (value) setServerBrief(value);
        setBriefLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setBriefLoading(false);
      });
    return () => controller.abort();
  }, [briefScope, canonicalGeneratedAt, selectedDate, spot.id]);

  const dayLabel = selectedDate ? formatLocalDateKey(selectedDate, spot.timezone) : null;
  const brief = serverBrief ?? fallbackBrief;
  // Collapse to one quiet line only when there is genuinely nothing to say:
  // no published brief and no local recommendation either. An in-flight or
  // not-yet-issued request is not yet nothing — denying a recommendation
  // before the Worker has answered would announce a false negative and then
  // quietly retract it.
  const hasBriefContent = Boolean(serverBrief) || fallbackBrief.picks.length > 0;
  const forecastUnavailable = forecastErrored || !forecast;
  const awaitingBrief = !hasBriefContent && !forecastUnavailable && (briefLoading || !selectedDate);

  return (
    <div className="analysisPanel">
      {dayLabel && (
        // The day picker lives on the Forecast tab, so the date-scoped outlook
        // must name its own day here — otherwise a Saturday brief reads as
        // today's call beside a hero keyed to a different date. An unparseable
        // date key gets no label rather than a fabricated one.
        <p className="analysisDayLabel">Outlook for {dayLabel}</p>
      )}
      {hasBriefContent ? (
        // Keyed by scope only: a generation-driven refresh must not remount the
        // card and collapse disclosures the reader has open.
        <DailyBriefErrorBoundary
          key={briefScope}
          fallback={<DailyBriefRecoveryCard brief={fallbackBrief} />}
        >
          <DailyBriefCard brief={brief} loading={briefLoading} spot={spot} />
        </DailyBriefErrorBoundary>
      ) : awaitingBrief ? (
        <p className="quietBriefLine" role="status" aria-busy="true">
          Loading the daily outlook…
        </p>
      ) : (
        <p className="quietBriefLine" role="status">
          {forecastUnavailable
            ? "Forecast data for this spot is temporarily unavailable, so there is no analysis to show yet."
            : "No daylight recommendation for this day. Every available public input is still listed on the Forecast tab."}
        </p>
      )}
      <div className="analysisTools">
        <ForecastLearningGuide />
      </div>
      {forecast && <DataHealthPanel forecast={forecast} selected={selected} spot={spot} />}
    </div>
  );
}
