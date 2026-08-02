import type { ApiSpot } from "@surf/contracts";
import { CloudOff, LineChart as LineChartIcon, ShieldCheck, Waves, Wind } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis
} from "recharts";
import type { ForecastInterval, TideEvent, WorkbenchWindow } from "./forecast-adapter";
import {
  forecastSlotTimestamps,
  localDayDomain,
  localHourForTimestamp
} from "./workbench-time";

export type ForecastChartDatum = {
  timestamp: number;
  forecastAt: string | null;
  isGap: boolean;
  isDaylight: boolean;
  modeledHeightFt: number | null;
  windSpeedKt: number | null;
  windGustKt: number | null;
  windRelation: string | null;
  tideFt: number | null;
  confidence: number | null;
};

type TooltipEntry = {
  color?: string;
  dataKey?: string | number;
  name?: string;
  payload?: ForecastChartDatum;
  value?: number | string;
};

function formatClock(value: number | string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone
  }).format(new Date(value));
}

function formatTimestamp(value: number | string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone
  }).format(new Date(value));
}

export function buildForecastChartData(
  windows: WorkbenchWindow[],
  interval: ForecastInterval,
  timezone: string
): ForecastChartDatum[] {
  const first = windows[0];
  if (!first) return [];
  const slots = forecastSlotTimestamps(first.localDateKey, interval, timezone);
  const stepMs = (interval === "1h" ? 1 : 3) * 60 * 60 * 1000;
  const rowsByTimestamp = new Map<number, { distance: number; window: WorkbenchWindow }>();
  const dayWindows = windows.filter((window) => window.localDateKey === first.localDateKey);

  for (const window of dayWindows) {
    const forecastTimestamp = new Date(window.forecastAt).getTime();
    if (!Number.isFinite(forecastTimestamp)) continue;
    let closestSlot: number | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const slot of slots) {
      const distance = Math.abs(slot - forecastTimestamp);
      if (distance < closestDistance) {
        closestSlot = slot;
        closestDistance = distance;
      }
    }
    if (closestSlot === null || closestDistance > stepMs / 2) continue;
    const existing = rowsByTimestamp.get(closestSlot);
    if (!existing || closestDistance < existing.distance) {
      rowsByTimestamp.set(closestSlot, { distance: closestDistance, window });
    }
  }

  const daylightTimestamps = dayWindows
    .filter((window) => window.isDaylight)
    .map((window) => new Date(window.forecastAt).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const firstDaylightTimestamp = daylightTimestamps[0] ?? null;
  const lastDaylightTimestamp = daylightTimestamps.at(-1) ?? null;

  return slots.map((timestamp) => {
    const window = rowsByTimestamp.get(timestamp)?.window;
    const localHour = localHourForTimestamp(timestamp, timezone);
    return {
      timestamp,
      forecastAt: window?.forecastAt ?? null,
      isGap: !window,
      isDaylight: window?.isDaylight ?? (
        firstDaylightTimestamp !== null && lastDaylightTimestamp !== null
          ? timestamp >= firstDaylightTimestamp && timestamp <= lastDaylightTimestamp
          : localHour >= 6 && localHour < 18
      ),
      modeledHeightFt: window?.modeledHeightFt ?? null,
      windSpeedKt: window?.windSpeedKt ?? null,
      windGustKt: window?.windGustKt ?? null,
      windRelation: window?.windRelation ?? null,
      tideFt: window?.tideFt ?? null,
      confidence: window?.confidence ?? null
    };
  });
}

function WorkbenchTooltip({
  active,
  label,
  payload,
  spot,
  kind
}: {
  active?: boolean;
  label?: number | string;
  payload?: readonly TooltipEntry[];
  spot: ApiSpot;
  kind: "wave" | "wind" | "tide" | "confidence";
}) {
  if (!active || label === undefined) return null;
  const datum = payload?.find((entry) => entry.payload)?.payload;
  const units = kind === "wind" ? " kt" : kind === "confidence" ? "%" : " ft";
  return (
    <div className="graphTooltip">
      <strong>{formatTimestamp(label, spot.timezone)}</strong>
      <span className={datum?.isDaylight ? "daylightContext" : "nightContext"}>
        {datum?.isDaylight ? "Daylight" : "Night context"}
      </span>
      {datum?.isGap ? (
        <p>No forecast row was returned for this time.</p>
      ) : (
        <>
          {payload?.flatMap((entry) => typeof entry.value === "number"
            ? [
                <span className="graphTooltipValue" key={String(entry.dataKey)}>
                  <i style={{ background: entry.color }} aria-hidden="true" />
                  {entry.name}: {entry.value.toFixed(kind === "confidence" ? 0 : 1)}{units}
                </span>
              ]
            : [])}
          {kind === "wind" && datum?.windRelation && <p>Beach relationship: {datum.windRelation}</p>}
        </>
      )}
    </div>
  );
}

export function ForecastGraph({
  windows,
  interval,
  tideEvents,
  selectedAt,
  spot,
  onSelect
}: {
  windows: WorkbenchWindow[];
  interval: ForecastInterval;
  tideEvents: TideEvent[];
  selectedAt: string | null;
  spot: ApiSpot;
  onSelect: (value: string) => void;
}) {
  const data = buildForecastChartData(windows, interval, spot.timezone);
  const localDateKey = windows[0]?.localDateKey;
  const domain = localDateKey ? localDayDomain(localDateKey, spot.timezone) : { start: 0, end: 0 };
  const domainStart = domain.start;
  const domainEnd = domain.end;
  const selectedTimestamp = data.find((datum) => datum.forecastAt === selectedAt)?.timestamp ?? null;
  const daylight = data.filter((datum) => datum.isDaylight);
  const daylightStart = daylight[0]?.timestamp ?? null;
  const lastDaylightIndex = daylight.length > 0
    ? data.findIndex((datum) => datum.timestamp === daylight.at(-1)!.timestamp)
    : -1;
  const daylightEnd = daylight.length > 0
    ? data[lastDaylightIndex + 1]?.timestamp ?? domainEnd
    : null;
  const visibleTideEvents = tideEvents
    .map((event) => ({ ...event, timestamp: new Date(event.at).getTime() }))
    .filter((event) => event.timestamp >= domainStart && event.timestamp < domainEnd);
  const gapCount = data.filter((datum) => datum.isGap).length;
  const slotEnd = (index: number) => data[index + 1]?.timestamp ?? domainEnd;

  const selectChartPoint = (state: unknown) => {
    const label = (state as { activeLabel?: unknown } | null)?.activeLabel;
    const timestamp = typeof label === "number" ? label : Number(label);
    if (!Number.isFinite(timestamp)) return;
    const forecastAt = data.find((datum) => datum.timestamp === timestamp)?.forecastAt;
    if (forecastAt) onSelect(forecastAt);
  };
  const xTicks = data
    .filter((datum) => interval === "3h" || localHourForTimestamp(datum.timestamp, spot.timezone) % 3 === 0)
    .map((datum) => datum.timestamp);
  const xAxis = () => (
    <XAxis
      type="number"
      scale="time"
      dataKey="timestamp"
      domain={[domainStart, domainEnd]}
      ticks={xTicks}
      tickFormatter={(value: number) => formatClock(value, spot.timezone)}
      minTickGap={24}
      tickLine={false}
      axisLine={false}
      fontSize={11}
      allowDataOverflow
    />
  );
  const contextBands = (prefix: string) => (
    <>
      {daylightStart === null || daylightEnd === null ? (
        <ReferenceArea key={`${prefix}-night-all`} x1={domainStart} x2={domainEnd} fill="#dfe5e3" fillOpacity={0.45} />
      ) : (
        <>
          {daylightStart > domainStart && <ReferenceArea key={`${prefix}-night-am`} x1={domainStart} x2={daylightStart} fill="#dfe5e3" fillOpacity={0.45} />}
          {daylightEnd < domainEnd && <ReferenceArea key={`${prefix}-night-pm`} x1={daylightEnd} x2={domainEnd} fill="#dfe5e3" fillOpacity={0.45} />}
        </>
      )}
      {data.map((datum, index) => datum.isGap ? (
        <ReferenceArea
          key={`${prefix}-gap-${datum.timestamp}`}
          x1={datum.timestamp}
          x2={slotEnd(index)}
          fill="#d7a14b"
          fillOpacity={0.1}
        />
      ) : null)}
    </>
  );
  const selectedLine = selectedTimestamp !== null
    ? <ReferenceLine x={selectedTimestamp} stroke="#1e6b5c" strokeDasharray="3 3" />
    : null;

  if (data.length === 0) {
    return <div className="workbenchEmpty" role="status"><CloudOff size={20} aria-hidden="true" /><span>No chartable inputs for this day.</span></div>;
  }

  return (
    <div className="forecastGraphs">
      <p className="srOnly" id="forecast-graph-summary">
        Four synchronized charts show modeled wave state, wind and gusts, tide, and confidence across the selected local day. {gapCount} time slot{gapCount === 1 ? " is" : "s are"} missing. Night periods are shaded. Use the time buttons or Table view for exact values.
      </p>

      <section className="chartCard" aria-labelledby="wave-chart-title">
        <div className="chartTitle"><div><Waves size={17} aria-hidden="true" /><h3 id="wave-chart-title">Modeled wave state</h3></div><span>Stepped across source validity</span></div>
        <div className="chartCanvas" role="img" aria-label="Stepped modeled nearshore wave-height chart" aria-describedby="forecast-graph-summary">
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={data} syncId="forecast-workbench" syncMethod="value" onClick={selectChartPoint} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              {contextBands("wave")}
              <CartesianGrid vertical={false} stroke="#e6eae7" />
              {xAxis()}
              <YAxis unit=" ft" width={44} tickLine={false} axisLine={false} fontSize={11} />
              <ChartTooltip content={<WorkbenchTooltip spot={spot} kind="wave" />} />
              <Line type="stepAfter" dataKey="modeledHeightFt" name="Modeled Hs" unit=" ft" stroke="#2b8695" strokeWidth={2.5} dot={false} connectNulls={false} />
              {selectedLine}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="chartCard" aria-labelledby="wind-chart-title">
        <div className="chartTitle"><div><Wind size={17} aria-hidden="true" /><h3 id="wind-chart-title">Wind and gusts</h3></div><span>Beach relationship in tooltip</span></div>
        <div className="chartCanvas" role="img" aria-label="Wind speed and gust chart" aria-describedby="forecast-graph-summary">
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={data} syncId="forecast-workbench" syncMethod="value" onClick={selectChartPoint} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              {contextBands("wind")}
              <CartesianGrid vertical={false} stroke="#e6eae7" />
              {xAxis()}
              <YAxis unit=" kt" width={44} tickLine={false} axisLine={false} fontSize={11} />
              <ChartTooltip content={<WorkbenchTooltip spot={spot} kind="wind" />} />
              <Line type="linear" dataKey="windGustKt" name="Gust" unit=" kt" stroke="#df9076" strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls={false} />
              <Line type="linear" dataKey="windSpeedKt" name="Wind" unit=" kt" stroke="#536f7a" strokeWidth={2.5} dot={false} connectNulls={false} />
              {selectedLine}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="chartCard" aria-labelledby="tide-chart-title">
        <div className="chartTitle"><div><LineChartIcon size={17} aria-hidden="true" /><h3 id="tide-chart-title">Tide</h3></div><span>MLLW with official extrema</span></div>
        <div className="chartCanvas" role="img" aria-label="Tide-height chart with high and low tide markers" aria-describedby="forecast-graph-summary">
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={data} syncId="forecast-workbench" syncMethod="value" onClick={selectChartPoint} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              {contextBands("tide")}
              <CartesianGrid vertical={false} stroke="#e6eae7" />
              {xAxis()}
              <YAxis unit=" ft" width={44} tickLine={false} axisLine={false} fontSize={11} />
              <ChartTooltip content={<WorkbenchTooltip spot={spot} kind="tide" />} />
              <Line type="linear" dataKey="tideFt" name="Tide" unit=" ft" stroke="#456db4" strokeWidth={2.5} dot={false} connectNulls={false} />
              {visibleTideEvents.map((event) => (
                <ReferenceLine
                  key={`${event.type}-${event.at}`}
                  x={event.timestamp}
                  stroke={event.type === "high" ? "#456db4" : "#7a8b8f"}
                  strokeDasharray="2 3"
                  label={{ value: `${event.type === "high" ? "H" : "L"} ${formatClock(event.timestamp, spot.timezone)}`, position: "insideTopRight", fill: "#60747a", fontSize: 9 }}
                />
              ))}
              {selectedLine}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="chartCard" aria-labelledby="confidence-chart-title">
        <div className="chartTitle"><div><ShieldCheck size={17} aria-hidden="true" /><h3 id="confidence-chart-title">Confidence</h3></div><span>Input and calibration trust</span></div>
        <div className="chartCanvas" role="img" aria-label="Forecast confidence chart from zero to one hundred percent" aria-describedby="forecast-graph-summary">
          <ResponsiveContainer width="100%" height={190}>
            <LineChart data={data} syncId="forecast-workbench" syncMethod="value" onClick={selectChartPoint} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              {contextBands("confidence")}
              <CartesianGrid vertical={false} stroke="#e6eae7" />
              {xAxis()}
              <YAxis unit="%" width={42} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickLine={false} axisLine={false} fontSize={11} />
              <ChartTooltip content={<WorkbenchTooltip spot={spot} kind="confidence" />} />
              <Line type="stepAfter" dataKey="confidence" name="Confidence" unit="%" stroke="#5f8e6f" strokeWidth={2.5} dot={false} connectNulls={false} />
              {selectedLine}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="graphTimeRail" aria-label="Select chart time">
        {windows.map((window) => (
          <button
            key={window.forecastAt}
            type="button"
            aria-pressed={selectedAt === window.forecastAt}
            onClick={() => onSelect(window.forecastAt)}
          >
            {formatClock(window.forecastAt, spot.timezone)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default ForecastGraph;
