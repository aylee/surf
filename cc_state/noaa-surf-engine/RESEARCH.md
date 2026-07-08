---
status: draft
type: research
---

# Personal Surf Forecast: Research & Analysis

**Date:** 2026-07-06
**Status:** Complete
**Lanes:** Internal, Web/Market, Technical Architecture

---

## Question

What would it take to build a true personal surf forecast, at near-zero recurring cost beyond Cloudflare, using NOAA/CDIP/NWS public data and Codex engineering effort?

More specifically: do we need to train a machine-learning model, use an off-the-shelf model, build a manual rules engine, use a Pydantic AI/LLM agent, or something else?

## Bottom Line

The default should be a direct public-data forecast engine, not a convenience marine API.

Do not pick one feed. A real surf forecast is a layered system. NOAA GFSwave is the offshore forecast backbone, CDIP/MOP is the nearshore shortcut where available, NDBC/CDIP buoys are ground truth, CO-OPS owns tides, NWS/model winds own surface conditions and hazards, and the app's spot model translates all of that into surf quality. The ambitious OSS version should make those roles explicit and let self-hosters enable the best feeds for their region.

We do **not** need to train a wave-forecasting ML model from scratch. NOAA and CDIP already run the expensive physics models. The right first-principles design is:

1. **Use off-the-shelf physics model outputs** from NOAA GFS Wave / WAVEWATCH-style products and CDIP wave models.
2. **Extract and normalize the model output ourselves** with Python tooling (`wgrib2`, `xarray`, `cfgrib`, `netCDF`) running in a Cloudflare Container or other scheduled Linux runtime.
3. **Build a spot-specific downscaling/calibration layer** that translates offshore/model wave energy into likely surf quality at Alex's actual spots.
4. **Use ML later only as a calibration layer** once we have labeled history: observed buoy/model/tide/wind features plus Alex's actual session quality ratings.
5. **Use LLM/Pydantic AI only for explanation and ops**, not for numeric forecasting.

Put plainly: Surfline-level output requires a forecast engine, but the "model" is mostly physics + signal processing + local spot calibration, not an LLM and not a brand-new neural network.

The biggest unlock is CDIP if the first spots are in California. CDIP provides observed buoys, modeled data, alongshore virtual-buoy points, model source code, and transformation coefficients. Its California model products are much closer to "surf forecast substrate" than generic NOAA buoy text files.

## Current State

There is no existing alex-os binder or prior research on a surf forecast tool. Local search only found Apple Health surfing workouts imported from Surfline, which confirms Surfline has been part of the personal workflow but not that any replacement has been designed.

The earlier spike biased toward shipping speed with Open-Meteo Marine. That was directionally useful for feasibility, but it is not the right default if Codex engineering time is cheap and recurring SaaS/API spend is the thing to avoid. Open-Meteo remains useful as a comparison oracle or temporary bootstrap, not the product architecture.

The relevant local defaults still hold:

- Cloudflare-first for frontend, API, storage, scheduling, and auth.
- TypeScript for the app/UI/API.
- Python only where mature scientific tooling is needed.
- D1/R2/KV are enough for a sole-user data product.
- Cloudflare Containers are now the cleanest Cloudflare-native way to run Python plus compiled geoscience tools.

## Findings

### Do Not Pick One Feed - Use Each Feed For Its Job

The feeds are not interchangeable. They answer different questions and should be composed.

| Layer | Primary Feed | Product Role | Strength | Tradeoff | Default |
|---|---|---|---|---|---|
| Offshore wave forecast | NOAA/NCEP GFSwave via NOMADS | Forecast swell/wind-wave energy before it reaches shore | Free, official, global/regional, model-cycle based | GRIB2, coarse relative to surf spots, not a spot-quality forecast | Mandatory |
| Nearshore wave transform | CDIP modeled data / MOP where available | Translate offshore energy toward the coast/virtual nearshore points | Closest public surf substrate for California; includes modeled/alongshore points | California-centric; netCDF/THREDDS complexity | Mandatory where available |
| Observed wave truth | NDBC buoys + CDIP buoys | Validate nowcast, bias-correct models, build historical calibration | Real measurements, historical archives | Sparse, offshore/station-specific, can miss exact break | Mandatory |
| Tides/water level | NOAA CO-OPS | Tide height/trend, water level, currents where stations support it | Authoritative, JSON API, predictable | Station proximity can matter; tides do not describe surf quality alone | Mandatory |
| Wind/weather/hazards | NWS API, plus HRRR/GFS/NBM-style model feeds later | Wind quality, advisories, marine hazards, weather context | JSON path available; model path can get high-res wind | NWS API is forecast product shaped, model feeds add more GRIB complexity | Mandatory NWS, model wind later |
| Bathymetry/exposure | NOAA ETOPO / regional DEMs | Future custom nearshore modeling, spot exposure priors | Public, necessary for SWAN/custom transforms | Large geospatial data; not needed if CDIP/MOP covers the spot | Optional until SWAN |
| Forecast comparison | Open-Meteo, manual Surfline comparison, other allowed APIs | Evaluation oracle, sanity check, regression tests | Easy to compare against | Not source of truth; paid/proprietary risk | Optional |
| Human/visual labels | Alex ratings, opt-in OSS ratings, allowed camera/user data | Surf-quality calibration label | Trains the subjective layer | Sparse at first; licensing/privacy must be explicit | Optional but important |

The build should treat feeds as adapters with declared capabilities:

```text
observed_wave
forecast_wave_offshore
forecast_wave_nearshore
tide
wind
hazard
bathymetry
quality_label
comparison_forecast
```

That makes the project viable as OSS. A self-hoster in California can enable CDIP/MOP. A self-hoster elsewhere can use GFSwave + NDBC + CO-OPS + NWS first, then add SWAN or a regional feed later. The app should show exactly which layers are active for each spot.

### A Surf Forecast Has Three Different "Models"

The word "model" is overloaded here. For this project it helps to split it into three layers.

| Layer | What It Does | Build or Use? | Default |
|---|---|---|---|
| Offshore wave model | Forecasts ocean wave fields from winds, spectra, propagation | Use NOAA/CDIP outputs | Off-the-shelf physics model |
| Nearshore transformation | Converts offshore wave energy to the coast/spot using bathymetry, direction, period, exposure | Use CDIP/MOP where available; otherwise build transfer functions | Physics/statistical downscaling |
| Surf quality model | Converts local wave/tide/wind into "good for this spot" | Build | Manual heuristics first, learned calibration later |

So the answer is not "train an ML model." The first real model we build is a **spot calibration model**: a transparent function that says, for this break, this swell direction/period/height plus this tide and wind equals likely surf quality. That function can be manual at first and statistically improved over time.

### NOAA Already Produces the Offshore Forecast

NOAA/NCEP publishes operational wave model products through NOMADS and the NCEP product inventory. The NCEP WAVE inventory lists GFSwave products, including a West Coast domain at 0.16 degree resolution and GRIB2 access over HTTPS. NOMADS' GFS Wave filter explicitly supports subsetting GRIB2 files by time, field, level, and region.

That means we do not need to forecast waves from atmospheric inputs ourselves. We need to pull the right variables from NOAA's forecast output:

- significant wave height;
- primary wave direction;
- primary/peak period;
- wind-wave height/period/direction;
- swell partitions where available;
- model run time and forecast horizon;
- regional domain and grid metadata.

The implementation detail is GRIB2. Cloudflare Workers are the wrong place to parse GRIB2 directly. A small Python/Linux processing job is the right tool.

### GRIB2 Processing Is Solved Tooling, Not Research Science

The practical GRIB2 stack is mature:

- **NOMADS filter**: request only the required fields, forecast hours, and bounding box instead of downloading full model files.
- **wgrib2**: NOAA/NCEP utility that can inventory, subset, extract point values, regrid/interpolate, and export GRIB2 to CSV/text/netCDF.
- **cfgrib + ecCodes + xarray**: Python path for opening GRIB files as xarray datasets.
- **netCDF/xarray**: natural format for CDIP, model artifacts, and downstream analysis.

The forecast extractor should start simple:

1. Select latest complete model cycle.
2. Use NOMADS to subset the West Coast / target-region GFSwave files by bounding box and variables.
3. Store the raw subset in R2 with run metadata.
4. Use `wgrib2 -lon` or `xarray` interpolation to extract point time series for each configured spot/deepwater reference point.
5. Normalize into D1 tables.

This is a few Codex-sized engineering tasks, not a scientific invention.

### CDIP Is the Nearshore Shortcut for California

For California, CDIP materially changes the problem.

CDIP exposes:

- realtime and archived buoy observations;
- modeled data through THREDDS/netCDF;
- Python API and CGI scripts;
- model output for validation points, grid points, and alongshore points;
- alongshore points generally 10m-20m deep and 100m apart along the California coast;
- MOP v1.1 source code, site definitions, and transformation coefficients.

The CDIP model docs say the newer California spectral refraction model predicts wave heights, periods, and directions, uses multiple offshore buoys, applies time lags, and standardizes resolution across California. The forecast model combines a global deepwater wave model with CDIP's shallow-water spectral refraction model to propagate wave energy across the continental shelf toward 10m depth.

This is much closer to Surfline's core challenge than generic offshore NOAA data. For California spots, the default should be:

1. Map each surf spot to the nearest CDIP alongshore/MOP output point when possible.
2. Use CDIP modeled nearshore output as a first-class forecast input.
3. Use NOAA GFSwave as the independent offshore forecast and fallback.
4. Use CDIP/NDBC observed buoy spectra to validate and bias-correct the model.

If the first spots are California spots, we may not need to run SWAN or invent bathymetry transforms for v0. CDIP has already done a large part of that work.

### Surfline-Level Accuracy Comes From Downscaling and Calibration

A generic offshore forecast can say "WNW swell 5 ft at 14s." Surfline-level usefulness comes from knowing what that means at a specific beach.

That requires a spot profile:

```yaml
spot: ocean-beach-sf
lat: 37.759
lon: -122.510
timezone: America/Los_Angeles
shore_normal_deg: 255
best_swell_dirs: [250, 310]
acceptable_swell_dirs: [220, 330]
best_period_sec: [10, 18]
best_tide_ft_mllw: [1.0, 4.5]
offshore_wind_from_deg: [45, 135]
max_wind_kt_good: 10
max_wind_kt_ok: 16
reference_buoys: [46026, 46013]
cdip_stations: []
cdip_mop_point: null
tide_station: 9414290
notes: "Exposed beachbreak; spot-specific calibration required."
```

Then the app needs two outputs:

- **forecasted conditions**: what the ocean/tide/wind will do;
- **surf quality**: whether those conditions are good for this spot.

The second output is where manual/local knowledge matters. It should start as a transparent scoring function:

- wave angle relative to shore normal;
- swell period and height;
- tide window and tide trend;
- wind angle and wind speed;
- source freshness;
- buoy/model agreement;
- confidence penalty for missing/stale inputs.

This is manual in the sense that we write the first scoring rules. It becomes statistical over time as Alex labels sessions.

### ML Is a Phase 3 Calibration Tool, Not the Engine

ML becomes useful after we have enough labeled examples:

```text
features:
  model_wave_height
  model_primary_period
  model_primary_direction
  cdip_nearshore_height
  observed_buoy_height
  observed_buoy_period
  tide_level
  tide_trend
  wind_speed
  wind_direction_relative_to_shore
  source_age
  day_of_year

label:
  alex_rating: 1-5
```

The right ML ladder is:

1. Hand-tuned scoring.
2. Linear/logistic regression or gradient boosted trees for calibration.
3. Direction/period transfer matrix learned per spot.
4. Only then consider neural nets if the simple models underperform.

The dataset will be tiny at first. A complex ML model would overfit and be harder to trust. The best near-term accuracy gain is better source data and spot calibration, not model complexity.

### Calibration Does Not Need To Wait On Alex's Anecdotes

There are two different calibration targets.

**Conditions calibration** can start immediately with public history. It asks: "Did our model predict the observed ocean/wind/tide correctly?"

Use historical NDBC/CDIP/CO-OPS/model data to learn:

- model height bias by region, buoy, swell direction, and period;
- timing/arrival lag by swell direction and source;
- direction bias and spreading issues;
- nearshore transfer coefficients from offshore model point to CDIP/MOP or buoy point;
- confidence penalties when model and observed buoy disagree;
- station reliability and freshness patterns.

This requires no personal surf anecdotes. It produces a better physical forecast.

**Surf-quality calibration** does need labels eventually. It asks: "Were those conditions actually good at this break?" But we can fast-track the cold start:

- seed spot rules from beach orientation, tide range, wind exposure, bathymetry, and known spot priors;
- use CDIP/MOP alongshore points as virtual nearshore labels where available;
- invite OSS users to contribute anonymized spot ratings with source snapshots;
- support bring-your-own camera/frame labels where the user owns or has permission to use the imagery;
- compare against allowed public/paid forecasts manually during evaluation, without making them a dependency.

The OSS version should define a portable calibration record:

```json
{
  "spot_id": "ocean-beach-sf",
  "observed_at": "2026-01-15T15:00:00Z",
  "rating": 4,
  "label_source": "human_session",
  "conditions_snapshot": {
    "nearshore_height_m": 1.6,
    "peak_period_s": 14,
    "primary_direction_deg": 285,
    "tide_ft_mllw": 2.8,
    "wind_speed_ms": 3.1,
    "wind_direction_deg": 85
  }
}
```

That creates a path where Alex is not the only source of signal. The project can bootstrap from physics backtests, spot priors, and community labels.

### Agents Should Write Reports, Not Forecast The Ocean

A Pydantic AI agent can help around the edges:

- validate source status and summarize pipeline failures;
- generate a human-readable daily surf report from structured forecast rows;
- explain why the score is high/low;
- answer "why does the app disagree with Surfline today?" by inspecting data provenance;
- propose scoring-rule changes after enough feedback.

But the numeric forecast should be deterministic and typed. LLMs should never infer missing wave heights, interpolate data, or decide the score from raw prose. If we use Pydantic AI, it sits after the forecast engine and consumes structured data.

The report layer is still a first-class product surface. The target is an OpenSnow-style daily narrative:

- what changed overnight;
- best windows by spot/region;
- confidence and model disagreement;
- swell source and arrival timing;
- wind/tide caveats;
- what to watch tomorrow;
- "why this could bust" section.

This can make the OSS project feel alive without compromising forecast integrity.

### Running SWAN Is Possible, But Not the Default First Move

SWAN is the standard open-source nearshore wave model used for shallow-water transformation, and it can model effects like refraction, shoaling, breaking, and local wind-wave growth. It is the right class of tool when we need to create our own nearshore model for a region that lacks CDIP-style products.

But operationalizing SWAN is a bigger project:

- need bathymetry/topography grids;
- need boundary conditions from offshore wave spectra;
- need wind/current forcing if modeling local seas;
- need model grid setup per region;
- need validation against buoys or observations;
- need compute/runtime packaging.

For a one-user app, the better default is:

1. Use CDIP/MOP where available.
2. Build empirical direction/period transfer functions from NOAA/CDIP observations.
3. Consider SWAN only if a target spot lacks good nearshore data and the empirical model is not accurate enough.

### The Cloudflare-Native Architecture Can Still Hold

The direct-NOAA build still fits Cloudflare. The only change is adding Cloudflare Containers for the Python/scientific processing path.

| Need | Cloudflare Primitive |
|---|---|
| UI/API | Workers + TypeScript |
| Auth | Cloudflare Access |
| Raw GRIB/netCDF/source snapshots | R2 |
| Normalized observations/forecasts/scores | D1 |
| Cache/source freshness/config | KV |
| Scheduled ingestion | Worker Cron |
| Heavy GRIB/netCDF extraction | Cloudflare Container with Python + wgrib2/ecCodes |
| Fan-out/retries | Queues |

Cloudflare Containers are available on the Workers Paid plan and are designed for code that needs CPU, memory, disk, a full filesystem, or existing Linux tools. Pricing is usage-based with monthly included vCPU/memory/disk allocations in the paid plan. A small 4x/day model extraction job for a few spots should fit near the intended cost envelope, but this needs empirical validation once we know the subset size.

## Options

| Option | Pros | Cons | Effort | Confidence |
|---|---|---|---|---|
| **A. Direct NOAA/CDIP forecast engine** | No paid forecast API; closest to true forecast ownership; uses real physics model outputs; gives source transparency | Requires Python/container ETL and GRIB/netCDF handling | Medium | High |
| **B. CDIP-first California engine** | Best shortcut if spots are in California; nearshore model outputs and virtual buoys already exist | California-specific; still need NOAA/NWS/tide integration and spot scoring | Medium | High if CA spots |
| **C. Open-Meteo bootstrap** | Fast JSON path; useful comparison source | Third-party dependency; not the desired default; may mask NOAA processing work | Low | Medium |
| **D. Run SWAN ourselves** | Maximum control over nearshore physics outside CDIP regions | Bathymetry/model ops burden; validation required; more engineering than needed first | High | Medium |
| **E. Train ML model now** | Sounds flexible | Tiny labeled dataset; overfits; does not replace physics | Medium/High | Low |
| **F. LLM/Pydantic AI forecast agent** | Nice explanations and ops assistant | Wrong tool for numeric forecasting; non-deterministic | Low/Medium | Low for core forecast |
| **G. OSS layered feed engine** | Lets every region combine best public feeds; community can contribute adapters and spot profiles | More abstraction up front | Medium/High | High |

## Recommendation

Build Option A, with Option B as the preferred path when the first spots are in California.

The architecture should be a **direct public-data forecast engine**:

1. Ingest NOAA GFSwave model output from NOMADS.
2. Ingest CDIP modeled nearshore products and buoy observations where available.
3. Ingest NDBC observations, NOAA CO-OPS tides, and NWS wind/alerts.
4. Treat each feed as an adapter with declared capabilities.
5. Normalize all source data into D1 and R2.
6. Compute spot-level forecast and surf-quality scores with transparent heuristics.
7. Backtest physical forecasts against historical observations.
8. Collect Alex/community feedback and use it to calibrate surf quality over time.
9. Generate daily surf reports from deterministic forecast outputs.

Open-Meteo can remain in the repo as a comparison/evaluation feed, but it should not be the primary plan. Stormglass should be out unless a specific quality gap justifies paying.

Key uncertainties:

- First spot list. California vs non-California changes the nearshore strategy a lot.
- Whether CDIP alongshore/model points cover the exact breaks Alex cares about.
- How well NOAA GFSwave + CDIP/NDBC observations match real surf quality at those spots.
- Whether Cloudflare Containers are cost/latency efficient enough for the extraction job, or whether a tiny GitHub Actions/Railway fallback is simpler.

## Data Processing Blueprint

### 1. Spot Registry

Hand-create spot profiles with coordinates, shore normal, tide station, buoy/CDIP mappings, and first-pass quality rules.

### 2. Feed Registry

Each feed adapter declares:

- provider;
- geographic coverage;
- time horizon;
- resolution;
- data format;
- capabilities;
- retention/history;
- rate limits;
- attribution/license notes;
- parser/test fixtures.

The app does not "choose one feed." It assembles a forecast stack per spot based on available feed capabilities.

### 3. Source Ingestion

Pull:

- NOAA GFSwave GRIB2 subsets via NOMADS filter.
- CDIP modeled/observed netCDF via THREDDS/OpenDAP.
- NDBC realtime buoy text/spectral summaries.
- NOAA CO-OPS tide predictions and observations.
- NWS grid forecast and alerts.

### 4. Extraction

Python container:

- runs `wgrib2` inventories and point extraction for GFSwave;
- uses `cfgrib`/`xarray` where dataset-shaped extraction is cleaner;
- uses `netCDF4`/`xarray` for CDIP;
- writes raw artifacts to R2;
- writes normalized rows to D1.

### 5. Physical Backtesting

Use historical observations to score the physical forecast:

- forecast wave vs observed buoy/CDIP;
- tide forecast vs observed water level;
- wind forecast vs observed station when available;
- source freshness vs forecast error.

This is the first calibration loop and does not require Alex ratings.

### 6. Nearshore Transform

Default:

- CDIP/MOP alongshore point for California spots where available.
- Direction/period/height transfer table for each spot otherwise.

Later:

- learn transfer coefficients from observed/model history.
- run SWAN only if needed.

### 7. Quality Score

TypeScript Worker computes:

- wave fit;
- tide fit;
- wind fit;
- confidence/source freshness;
- final label and explanation.

### 8. Surf-Quality Calibration Loop

Every session/check:

- Alex rates actual surf quality.
- App snapshots forecast inputs at decision time.
- Weekly calibration job compares predicted score vs actual rating.
- Codex adjusts spot profile or calibrates a simple statistical model.

OSS version:

- allow self-hosters to keep labels local;
- optionally submit anonymized labels to a shared open calibration corpus;
- support region/spot profile PRs.

### 9. Agent Report Layer

Generate a daily report after the deterministic forecast job:

- structured forecast facts in;
- human-style narrative out;
- citations to source runs and confidence;
- no invented numeric conditions.

## Sources

**Internal**

- [Side Projects AREA.md](../../areas/side-projects/AREA.md)
- [Default Tech Stack](../../library/reference/tech-stack.md)
- qmd search over binders/logs/areas found no prior surf forecast research binder.

**External**

- [NCEP WAVE model product inventory](https://www.nco.ncep.noaa.gov/pmb/products/wave/)
- [NOMADS GFS Wave GRIB2 filter](https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl)
- [NOAA/NCEP wgrib2 documentation](https://www.cpc.ncep.noaa.gov/products/wesley/wgrib2/)
- [ECMWF cfgrib README](https://github.com/ecmwf/cfgrib)
- [CDIP data access documentation](https://cdip.ucsd.edu/m/documents/data_access.html)
- [CDIP California Wave Models](https://cdip.ucsd.edu/m/documents/models.html)
- [CDIP MOP v1.1 documentation](https://cdip.ucsd.edu/MOP_v1.1/)
- [CDIP MOP source code readme](https://cdip.ucsd.edu/code_access/MOP_v1.1/MOP_v1.1_readme.txt)
- [NOAA CO-OPS Data Retrieval API](https://api.tidesandcurrents.noaa.gov/api/prod/)
- [NDBC realtime data access FAQ](https://www.ndbc.noaa.gov/faq/rt_data_access.shtml)
- [NDBC historical data](https://www.ndbc.noaa.gov/historical_data.shtml)
- [NWS API Web Service](https://www.weather.gov/documentation/services-web-api)
- [NOAA ETOPO Global Relief Model](https://www.ncei.noaa.gov/products/etopo-global-relief-model)
- [Cloudflare Containers overview](https://developers.cloudflare.com/containers/)
- [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [SWAN user manual](https://swanmodel.sourceforge.io/online_doc/swanuse/swanuse.html)
