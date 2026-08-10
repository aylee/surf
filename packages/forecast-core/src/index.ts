export {
  NORCAL_REFERENCE_CONFIG,
  NORCAL_REFERENCE_CONFIG_VERSION,
  NORCAL_SPOTS,
  getOperationalObservedWaveSources,
  getSpotProfile,
  getSpotSourceMap,
  isNorcalSpotId
} from "./spot-registry";
export type { NorcalSpotProfile, NwsWaveGridSourceMapping } from "./spot-registry";
export { scoreSpotWindow } from "./scoring";
export {
  CANONICAL_RECOMMENDATION_SCORE_BAND,
  intervalOverlapsCivilLight,
  intervalOverlapsRange,
  selectCanonicalRecommendationIds,
  selectCanonicalRecommendationWindows
} from "./recommendations";
export type {
  CanonicalRecommendationCandidate,
  CanonicalRecommendationWindow
} from "./recommendations";
export { surfSizeRange } from "./surf-size";
export { DEFAULT_BREAKER_INDEX, estimateBreakingWaveHeight } from "./wave-transform";
export type { BreakingWaveEstimate, BreakingWaveInput } from "./wave-transform";
export {
  circularDistanceDeg,
  circularWindowCenterDeg,
  distanceToCircularWindowDeg,
  directionInCircularWindow,
  surfaceConditionForWind
} from "./surface";
export type { SurfaceCondition } from "./surface";
