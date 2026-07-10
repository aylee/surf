import type { ForecastResponse, ScoredForecastWindow } from "@surf/contracts";

function bestWindow(windows: ScoredForecastWindow[]): ScoredForecastWindow | undefined {
  return windows.filter((window) => window.ratingStatus === "scored").sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.confidence - left.confidence;
  })[0];
}

function formatWindow(window: ScoredForecastWindow): string {
  const at = new Date(window.forecastAt).toISOString();
  const wave =
    window.waveHeightFt === null || window.peakPeriodSec === null || window.primaryDirectionDeg === null
      ? "wave n/a"
      : `${window.waveHeightFt.toFixed(1)} ft @ ${window.peakPeriodSec.toFixed(0)}s from ${window.primaryDirectionDeg.toFixed(0)} deg`;
  const wind =
    window.windSpeedKt === null || window.windDirectionDeg === null
      ? "wind n/a"
      : `${window.windSpeedKt.toFixed(0)} kt from ${window.windDirectionDeg.toFixed(0)} deg`;
  const tide = window.tideFt === null ? "tide n/a" : `${window.tideFt.toFixed(1)} ft`;

  return `${at}: ${window.qualityLabel} ${window.score}/100, confidence ${window.confidence}/100, ${wave}, ${wind}, ${tide}`;
}

export function buildDeterministicReport(forecasts: ForecastResponse[], generatedAt = new Date()): string {
  const lines = [
    `# NorCal Surf Report`,
    ``,
    `Generated: ${generatedAt.toISOString()}`,
    ``,
    `This report summarizes deterministic forecast windows only. It does not create numeric wave, wind, tide, or score values.`,
    ``,
    `## Best Bets`
  ];

  for (const forecast of forecasts) {
    const best = bestWindow(forecast.windows);
    if (!best) {
      lines.push(`- ${forecast.spot.name}: no scored windows available.`);
      continue;
    }
    lines.push(`- ${forecast.spot.name}: ${formatWindow(best)}`);
  }

  const caveats = forecasts
    .flatMap((forecast) => forecast.windows.flatMap((window) => window.caveats))
    .filter((caveat, index, all) => all.indexOf(caveat) === index);

  lines.push(``, `## Source Caveats`);
  if (caveats.length === 0) {
    lines.push(`- No caveats reported by the scoring layer.`);
  } else {
    for (const caveat of caveats) lines.push(`- ${caveat}`);
  }

  return `${lines.join("\n")}\n`;
}
