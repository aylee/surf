# Forecast Accuracy and Alignment

Last evaluated: 2026-07-09 (America/Los_Angeles)

This project uses four different kinds of evidence. They must not be blended
into one "accuracy" number:

1. Measured physical observations: NDBC/CDIP buoys and active CO-OPS stations.
2. Scientific nearshore proxies: CDIP MOP hindcast/nowcast output at 10–15 m.
3. Forecast peers: Surf Captain and Surfline.
4. Actual break truth: timestamped human or camera labels of breaking-face
   height and surface texture.

Only the fourth category can establish whether a particular break was truly
"2–3 ft and clean." CDIP MOP is the strongest public nearshore reference
available now, but its significant wave height is still modeled at depth, not
a breaking-face measurement.

## What was tested

### 1. NOAA NDFD archive against CDIP MOP nearshore output

The test reconstructed 18 issued NOAA NDFD wave-height cycles across two dates
per month from April through December 2025. It evaluated the high-resolution
CONUS `YKUZ98_KWBN` (roughly 0–72 hours) and `YKUZ97_KWBN` (roughly 72–144
hours) products at the closest finite marine grid cell for five spots. Forecast
valid times were matched to the closest CDIP MOP nowcast time within 31 minutes.

- 5,195 matched forecast/verification pairs
- 18 distinct issue cycles
- Five spots: Ocean Beach North/Central/South, Linda Mar, and Stinson
- No Bolinas score: no MOP point represents the lagoon-mouth break
- UTC issue, valid, and lead times retained separately
- April–June used only to fit diagnostic scalar baselines; July–December held
  out

The current NWS-grid fixed transforms had an aggregate height MAE of **0.438 m
(1.44 ft)** and signed bias of **−0.402 m (−1.32 ft)** against MOP. Only about
24% of samples were within 0.15 m. Error stayed large across all lead buckets:

| Lead | Samples | MAE | Bias |
|---|---:|---:|---:|
| 0–24 h | 2,160 | 0.441 m / 1.45 ft | −0.422 m |
| 24–48 h | 1,440 | 0.484 m / 1.59 ft | −0.441 m |
| 48–72 h | 540 | 0.429 m / 1.41 ft | −0.365 m |
| 72–120 h | 705 | 0.384 m / 1.26 ft | −0.339 m |
| 120–144 h | 350 | 0.364 m / 1.19 ft | −0.309 m |

This does not mean NDFD itself is uniformly low. It means one scalar applied to
a coastal grid cell is a weak substitute for a spot-specific nearshore model.
Chronologically fitted scalars improved held-out MAE for Linda Mar, Ocean Beach
Central, and Stinson, but residual intervals remained too wide for honest
one-foot surf bands. Ocean Beach South's improvement was not stable across
issue-cycle bootstrap samples. The production decision is therefore to prefer
direct CDIP MOP forecasts and retain NWS as an explicitly low-confidence
fallback, not to tune a brittle scalar harder.

The GRIB coordinate/value association was cross-checked against the live NWS
grid API at Bolinas and Ocean Beach Central on 2026-07-10 UTC. Archive values
matched within 0.024 m and 0.0144 m respectively, exactly consistent with the
archive's 0.1 m packing versus the API's converted source units.

### 2. Direct CDIP MOP forecast against MOP nowcast

The current public MOP forecast cycle (issued from the 2026-07-07 model cycle)
overlapped 26 verifying nowcast hours at each of five mapped points. This is
only one weather event, but it is a true lead-time comparison rather than a
retrospective average.

| Spot | Pairs | Height MAE | Height bias | Period MAE | Circular direction MAE |
|---|---:|---:|---:|---:|---:|
| Ocean Beach North (`SF043`) | 26 | 0.055 m / 0.18 ft | +0.011 m | 1.16 s | 1.9° |
| Ocean Beach Central (`SF029`) | 26 | 0.093 m / 0.31 ft | −0.042 m | 1.20 s | 5.6° |
| Ocean Beach South (`SF015`) | 26 | 0.106 m / 0.35 ft | −0.008 m | 0.85 s | 9.9° |
| Linda Mar approach (`SM371`) | 26 | 0.155 m / 0.51 ft | −0.144 m | 0.59 s | 2.3° |
| Stinson (`MA122`) | 26 | 0.035 m / 0.11 ft | −0.025 m | 1.05 s | 2.7° |

Across all 130 pairs, height MAE was approximately **0.089 m (0.29 ft)** and
bias approximately **−0.042 m**. This is encouraging evidence for MOP as the
nearshore forecast source. It is not enough to claim stable accuracy: the
sample contains one issue cycle and MOP nowcast is a buoy-driven modeled proxy,
not an independent breaking-wave observation.

### 3. Same-time Bolinas peer alignment

At approximately 9 PM PDT on July 9, all three products saw essentially the
same physical setup: a roughly 2 ft, 16 s southwest swell; a 4.6–5.9 ft, 8–9 s
west/northwest component; 11–13 kt northwest wind; and roughly 4 ft of falling
tide.

| Product | Surf call | Wind interpretation | Notes |
|---|---|---|---|
| Surf Captain | 3+ ft, clean | WNW 13 mph | Regional south/southeast-facing forecast |
| Surfline | 2–3 ft, overall poor-to-fair | NW 11 kt, offshore | Overall rating is not a surface category |
| Deployed `surf` v1 | 3–4 ft, choppy | NW 10.4 kt, onshore | Size sat inside the peer disagreement; geometry was wrong |
| CDIP Bolinas-vicinity grid | 3.0–3.4 ft Hs | n/a | 4–5 m cells south of the lagoon; not break truth |

The useful result is not a winner between vendors. Surf Captain and Surfline
disagreed on surf size despite agreeing closely on swell, wind, and tide. The
actionable failure was ours: both peers treated NW/WNW as offshore for the
regional Bolinas page, while the current profile treated it as onshore. Bolinas
must use the intended lagoon-mouth break geometry, and it must remain
low-confidence until that target is confirmed and labeled.

Surf Captain's own [FAQ](https://surfcaptain.com/faq) says its height is a
wave-face estimate for average-to-better spots in a region, not an individual
break, and its clean/fair/choppy label is a wind/surface classification. Its
[History Mode announcement](https://surfcaptain.com/blog/1/new-forecast-features)
says retained history begins January 1, 2025, but does not document the saved
issue cycle or lead. It is therefore a peer-alignment dataset, not ground truth.
Surfline historical mode required a subscription in the test browser and was
not bypassed.

## Deterministic interpretation policy

The forecast engine owns the initial weights; vendors do not set them.

1. Use source wave energy and components, never an LLM, to compute numeric
   surf facts.
2. Prefer a mapped CDIP MOP nearshore forecast over a generic coastal-grid
   scalar.
3. Keep size separate from surface quality. A clean one-foot wave remains
   clean.
4. Derive clean/fair/choppy from wind speed and direction relative to the
   actual break geometry. Commercial overall quality ratings are not equivalent.
5. Treat tide and swell organization as ranking context, not as a hidden
   redefinition of "clean."
6. Preserve every issued forecast, source fingerprint, configuration hash, and
   display call so future tests cannot use hindsight.
7. Produce one-foot surf ranges from held-out residual quantiles once enough
   actual-break labels exist. Until then, retain low confidence and show the
   physical nearshore estimate honestly.

## Promotion gates

Do not describe a spot as calibrated until it has at least 60 distinct labeled
spot-days, at least 30 examples per surface class, and a frozen chronological
holdout. Initial targets are:

- height: at least 60% exact one-foot-band accuracy, 90% same-or-adjacent band,
  median miss at most 0.5 ft, and signed bias at most 0.25 ft;
- surface: macro F1 at least 0.70 and every class recall at least 0.60;
- revised transform: at least 15% lower held-out MAE than the current baseline,
  with no spot more than 10% worse;
- physical forecast: at least 10% lower MAE than persistence/raw baselines in
  each main lead bucket.

The immutable snapshot tables and raw-source artifacts added with this work are
the prospective dataset for those gates.
