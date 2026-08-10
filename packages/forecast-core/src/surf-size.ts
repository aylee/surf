/**
 * Human-facing deterministic surf-size estimate used across every product
 * surface. The input remains a modeled/derived forecast fact; this helper only
 * owns the shared display band and does not turn it into an observation.
 */
export function surfSizeRange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Size unavailable";
  if (value < 1) return "0–1 ft";
  if (value >= 10) return `${Math.round(value)} ft+`;
  const rounded = Math.round(value * 10) / 10;
  const lower = Number.isInteger(rounded) ? Math.max(0, rounded - 1) : Math.floor(rounded);
  const upper = Math.max(lower + 1, Math.ceil(rounded));
  return `${lower}–${upper} ft`;
}
