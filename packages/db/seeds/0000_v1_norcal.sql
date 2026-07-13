-- Generated from @surf/forecast-core's NorCal reference config and packages/db/src/norcal-seed-config.ts.
-- DO NOT EDIT BY HAND. Run: pnpm --filter @surf/db seed:generate
-- Reference config: norcal-reference-v1 (schema 1)

insert into spots (id, name, region, lat, lon, timezone, shore_normal_deg, config_json, active) values
  ('obsf-north', 'Ocean Beach North', 'norcal', 37.782, -122.514, 'America/Los_Angeles', 270, '{"bestSwellDeg":{"minDeg":280,"maxDeg":310},"workableSwellDeg":{"minDeg":240,"maxDeg":330},"bestPeriodSec":{"min":11,"max":18},"bestTideFt":{"min":0.5,"max":4.5},"offshoreWindFromDeg":{"minDeg":45,"maxDeg":140},"maxGoodWindKt":8,"maxOkWindKt":15,"notes":"Exposed SF beachbreak. Cold-start prior favors clean wind and moderate tides."}', 1),
  ('obsf-central', 'Ocean Beach Central', 'norcal', 37.759, -122.51, 'America/Los_Angeles', 270, '{"bestSwellDeg":{"minDeg":275,"maxDeg":310},"workableSwellDeg":{"minDeg":235,"maxDeg":330},"bestPeriodSec":{"min":10,"max":17},"bestTideFt":{"min":1,"max":5},"offshoreWindFromDeg":{"minDeg":45,"maxDeg":140},"maxGoodWindKt":8,"maxOkWindKt":15,"notes":"Primary v1 OBSF reference spot."}', 1),
  ('obsf-south', 'Ocean Beach South', 'norcal', 37.735, -122.506, 'America/Los_Angeles', 270, '{"bestSwellDeg":{"minDeg":275,"maxDeg":315},"workableSwellDeg":{"minDeg":235,"maxDeg":335},"bestPeriodSec":{"min":10,"max":17},"bestTideFt":{"min":1,"max":5},"offshoreWindFromDeg":{"minDeg":45,"maxDeg":145},"maxGoodWindKt":8,"maxOkWindKt":15,"notes":"Exposed beachbreak; needs local calibration for bars and tide sensitivity."}', 1),
  ('linda-mar', 'Linda Mar / Pacifica', 'norcal', 37.594, -122.506, 'America/Los_Angeles', 250, '{"bestSwellDeg":{"minDeg":250,"maxDeg":295},"workableSwellDeg":{"minDeg":210,"maxDeg":320},"bestPeriodSec":{"min":8,"max":15},"bestTideFt":{"min":0.5,"max":4},"offshoreWindFromDeg":{"minDeg":45,"maxDeg":145},"maxGoodWindKt":8,"maxOkWindKt":14,"notes":"Protected beginner-friendly beach; smaller swell windows matter."}', 1),
  ('stinson', 'Stinson', 'norcal', 37.899, -122.644, 'America/Los_Angeles', 225, '{"bestSwellDeg":{"minDeg":210,"maxDeg":285},"workableSwellDeg":{"minDeg":190,"maxDeg":310},"bestPeriodSec":{"min":8,"max":15},"bestTideFt":{"min":1,"max":5},"offshoreWindFromDeg":{"minDeg":45,"maxDeg":135},"maxGoodWindKt":8,"maxOkWindKt":14,"notes":"More sheltered than OBSF; local transform and tide calibration needed."}', 1),
  ('bolinas', 'Bolinas — Wharf/Brighton', 'norcal', 37.909, -122.687, 'America/Los_Angeles', 215, '{"bestSwellDeg":{"minDeg":210,"maxDeg":285},"workableSwellDeg":{"minDeg":190,"maxDeg":310},"bestPeriodSec":{"min":8,"max":15},"bestTideFt":{"min":0.5,"max":4.5},"offshoreWindFromDeg":{"minDeg":270,"maxDeg":20},"maxGoodWindKt":8,"maxOkWindKt":14,"notes":"Regional Wharf/Brighton-facing Bolinas report. NW/WNW is offshore for the southeast-facing beach; keep wave-height confidence low until a direct nearshore source is resolved."}', 1)
on conflict(id) do update set
  name = excluded.name,
  region = excluded.region,
  lat = excluded.lat,
  lon = excluded.lon,
  timezone = excluded.timezone,
  shore_normal_deg = excluded.shore_normal_deg,
  config_json = excluded.config_json,
  active = excluded.active;

insert into sources (id, name, type, provider, external_id, url, format, parser_runtime, attribution, license_note, refresh_minutes, active, metadata_json) values
  ('cdip:mop-forecast', 'CDIP MOP public per-point nearshore forecast', 'forecast_wave_nearshore', 'CDIP/MOP', 'MOP_alongshore', 'https://thredds.cdip.ucsd.edu/thredds/catalog/cdip/model/MOP_alongshore/catalog.html', 'opendap_ascii', 'worker', 'Coastal Data Information Program MOP modeled wave forecasts', 'Public CDIP model output. Retain point ID, raw Hs, depth, Last-Modified source update, deterministic transform inputs, and the distinction from observed surf-face truth.', 180, 1, '{"adapter":"fetchCdipMopForecastsForSpots","variables":["waveTime","waveHs","waveTp","waveDp","waveDm"],"sourceTimestampSemantics":"http_last_modified_source_update_not_model_cycle","heightSemantics":"modeled_significant_wave_height_not_breaking_face_height","experimentalTransform":"bulk-hs-linear-shoaling-v1","experimentalTransformAffectsDisplay":false,"breakerIndex":0.78}'),
  ('ndbc:realtime2-standard-meteorological', 'NDBC realtime wave observation adapter', 'observed_wave', 'NOAA/NDBC', 'realtime2', 'https://www.ndbc.noaa.gov/data/realtime2/', 'ndbc_text', 'worker', 'NOAA National Data Buoy Center realtime2 observations', 'Public NOAA/NDBC observations; retain station and observation time.', 30, 1, '{"adapter":"fetchNdbcRealtimeObservationsForStations","stations":["46237","46026","46013","46012"]}'),
  ('ndbc-46237', 'NDBC 46237 San Francisco Bar buoy', 'observed_wave', 'NOAA/NDBC', '46237', 'https://www.ndbc.noaa.gov/station_page.php?station=46237', 'ndbc_text', 'worker', 'NOAA/NDBC Station 46237 / CDIP 142', 'Public NOAA/NDBC observations; retain station attribution.', 30, 1, '{"station":"46237","cdipStation":"142","notes":"Nearshore San Francisco Bar reference used by the surf nowcast."}'),
  ('ndbc-46026', 'NDBC 46026 San Francisco buoy', 'observed_wave', 'NOAA/NDBC', '46026', 'https://www.ndbc.noaa.gov/station_page.php?station=46026', 'ndbc_text', 'worker', 'NOAA/NDBC Station 46026', 'Public NOAA/NDBC observations; retain station attribution.', 60, 1, '{"station":"46026","notes":"Primary observed-wave reference for Ocean Beach and broader SF approaches."}'),
  ('ndbc-46013', 'NDBC 46013 Bodega Bay buoy', 'observed_wave', 'NOAA/NDBC', '46013', 'https://www.ndbc.noaa.gov/station_page.php?station=46013', 'ndbc_text', 'worker', 'NOAA/NDBC Station 46013', 'Public NOAA/NDBC observations; retain station attribution.', 60, 1, '{"station":"46013","notes":"Secondary north-coast observed-wave reference for Marin/SF."}'),
  ('ndbc-46012', 'NDBC 46012 Half Moon Bay buoy', 'observed_wave', 'NOAA/NDBC', '46012', 'https://www.ndbc.noaa.gov/station_page.php?station=46012', 'ndbc_text', 'worker', 'NOAA/NDBC Station 46012', 'Public NOAA/NDBC observations; retain station attribution.', 60, 1, '{"station":"46012","notes":"Southern reference buoy for Linda Mar/Pacifica."}'),
  ('coops-9414290', 'NOAA CO-OPS San Francisco tide station', 'tide', 'NOAA CO-OPS', '9414290', 'https://api.tidesandcurrents.noaa.gov/api/prod/', 'json', 'worker', 'NOAA CO-OPS Station 9414290', 'Public NOAA CO-OPS tide and water-level data; retain station attribution.', 360, 1, '{"station":"9414290","datum":"MLLW","units":"english","notes":"Shared reference tide station for Ocean Beach."}'),
  ('coops-9414131', 'NOAA CO-OPS Pillar Point Harbor tide station', 'tide', 'NOAA CO-OPS', '9414131', 'https://api.tidesandcurrents.noaa.gov/api/prod/', 'json', 'worker', 'NOAA CO-OPS Station 9414131', 'Public NOAA CO-OPS tide and water-level data; retain station attribution.', 360, 1, '{"station":"9414131","datum":"MLLW","units":"english","notes":"Linda Mar / Pacifica reference tide station."}'),
  ('coops-9414958', 'NOAA CO-OPS Bolinas Lagoon tide station', 'tide', 'NOAA CO-OPS', '9414958', 'https://api.tidesandcurrents.noaa.gov/api/prod/', 'json', 'worker', 'NOAA CO-OPS Station 9414958', 'Public NOAA CO-OPS tide and water-level data; retain station attribution.', 360, 1, '{"station":"9414958","datum":"MLLW","units":"english","notes":"Stinson and Bolinas reference tide station."}'),
  ('coops:tide-predictions', 'NOAA CO-OPS tide prediction adapter', 'tide', 'NOAA CO-OPS', 'predictions', 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter', 'json', 'worker', 'NOAA CO-OPS predictions API', 'Public NOAA CO-OPS tide and water-level data; retain station attribution.', 360, 1, '{"adapter":"fetchCoopsTidePredictionsForSpots","stations":["9414290","9414131","9414958"]}'),
  ('nws:mtr-grid-wave', 'NWS MTR coastal marine grid wave forecast', 'forecast_wave_nearshore', 'NOAA/NWS MTR', 'MTR-grid-wave', 'https://api.weather.gov/gridpoints/MTR/', 'geojson', 'worker', 'NOAA/NWS MTR raw 2.5 km coastal marine grid forecast', 'Public National Weather Service forecast data; retain source grid, model update time, and derivation.', 60, 1, '{"adapter":"fetchNwsGridWaveForSpots","fields":["waveHeight","wavePeriod","wavePeriod2","primarySwellHeight","primarySwellDirection","secondarySwellHeight","secondarySwellDirection","windWaveHeight"],"derivation":"raw significant height multiplied by explicit per-spot cold-start scale"}'),
  ('nws:point-forecast-alerts', 'NWS point forecast and alerts adapter', 'wind', 'NWS', 'points-alerts', 'https://api.weather.gov/', 'json', 'worker', 'National Weather Service points, grid forecast, and active alerts APIs', 'Public NWS API data; provide User-Agent and retain attribution.', 60, 1, '{"adapter":"fetchNwsContextForSpots","capabilities":["wind","hazard"]}')
on conflict(id) do update set
  name = excluded.name,
  type = excluded.type,
  provider = excluded.provider,
  external_id = excluded.external_id,
  url = excluded.url,
  format = excluded.format,
  parser_runtime = excluded.parser_runtime,
  attribution = excluded.attribution,
  license_note = excluded.license_note,
  refresh_minutes = excluded.refresh_minutes,
  active = excluded.active,
  metadata_json = excluded.metadata_json;

-- These IDs belonged to earlier generated seeds but are not live v1 adapters.
-- Keep upgrade behavior explicit without deleting historical source/run rows.
update sources set active = 0
where id in ('noaa-gfswave-norcal', 'cdip-mop-norcal-unmapped', 'nws-grid-norcal', 'nws-alerts-norcal');
