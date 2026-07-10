const ONE_HOUR_MS = 60 * 60 * 1000;

export function stableThreeHourForecastTimes(
  now: Date,
  horizonHours = 120,
  timeZone = "America/Los_Angeles"
): string[] {
  const count = Math.floor(horizonHours / 3) + 1;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23"
  });
  let candidateMs = Math.ceil(now.getTime() / ONE_HOUR_MS) * ONE_HOUR_MS;
  const times: string[] = [];

  // Iterating UTC hours keeps this correct through local daylight-saving gaps and folds.
  while (times.length < count) {
    const candidate = new Date(candidateMs);
    const hour = Number(formatter.formatToParts(candidate).find((part) => part.type === "hour")?.value);
    if (Number.isInteger(hour) && hour % 3 === 0) times.push(candidate.toISOString());
    candidateMs += ONE_HOUR_MS;
  }

  return times;
}
