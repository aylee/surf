from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import pytest

from surf_extractor.feeds import (
    GfsWaveCycleUnavailable,
    GfsWaveInventoryUnavailable,
    GfsWaveInventoryValidationError,
    GfsWavePoint,
    GfsWaveRequest,
    build_gfswave_cycle_plan,
    latest_complete_cycle,
    norcal_bbox,
    normalize_gfswave_point_series,
    select_latest_complete_gfswave_cycle,
    validate_gfswave_inventory,
)


SAMPLE_WCOAST_IDX = """\
1:0:d=2026070812:WIND:surface:3 hour fcst:
5:66247:d=2026070812:HTSGW:surface:3 hour fcst:
6:75925:d=2026070812:PERPW:surface:3 hour fcst:
7:87128:d=2026070812:DIRPW:surface:3 hour fcst:
8:103926:d=2026070812:WVHGT:surface:3 hour fcst:
9:112460:d=2026070812:SWELL:1 in sequence:3 hour fcst:
12:143614:d=2026070812:WVPER:surface:3 hour fcst:
13:153425:d=2026070812:SWPER:1 in sequence:3 hour fcst:
16:196581:d=2026070812:WVDIR:surface:3 hour fcst:
17:210314:d=2026070812:SWDIR:1 in sequence:3 hour fcst:
"""

MISSING_DIRECTION_IDX = """\
5:66247:d=2026070812:HTSGW:surface:3 hour fcst:
6:75925:d=2026070812:PERPW:surface:3 hour fcst:
"""


def test_gfswave_url_contains_bbox_and_variables() -> None:
    request = GfsWaveRequest(
        cycle=datetime(2026, 7, 8, 12, tzinfo=timezone.utc),
        forecast_hour=6,
        bbox=norcal_bbox(),
    )

    url = request.nomads_filter_url()
    query = parse_qs(urlparse(url).query, keep_blank_values=True)

    assert "filter_gfswave.pl" in url
    assert query["dir"] == ["/gfs.20260708/12/wave/gridded"]
    assert query["file"] == ["gfswave.t12z.wcoast.0p16.f006.grib2"]
    assert query["subregion"] == [""]
    assert query["leftlon"] == ["-124"]
    assert query["rightlon"] == ["-121.5"]
    assert query["var_HTSGW"] == ["on"]
    assert query["var_PERPW"] == ["on"]
    assert query["var_DIRPW"] == ["on"]
    assert query["lev_surface"] == ["on"]
    assert query["lev_1_in_sequence"] == ["on"]
    assert request.inventory_url() == (
        "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/"
        "gfs.20260708/12/wave/gridded/gfswave.t12z.wcoast.0p16.f006.grib2.idx"
    )
    assert request.r2_key == (
        "raw/noaa-gfswave-wcoast-0p16/cycle=2026070812/lead=f006/norcal.grib2"
    )


def test_latest_complete_cycle_rounds_to_six_hour_boundary() -> None:
    cycle = latest_complete_cycle(datetime(2026, 7, 8, 14, 12, tzinfo=timezone.utc))
    assert cycle.isoformat() == "2026-07-08T12:00:00+00:00"


def test_latest_complete_cycle_respects_minimum_cycle_age() -> None:
    cycle = latest_complete_cycle(datetime(2026, 7, 8, 12, 30, tzinfo=timezone.utc))
    assert cycle.isoformat() == "2026-07-08T06:00:00+00:00"

    cycle = latest_complete_cycle(
        datetime(2026, 7, 8, 12, 30, tzinfo=timezone.utc),
        minimum_cycle_age=timedelta(minutes=15),
    )
    assert cycle.isoformat() == "2026-07-08T12:00:00+00:00"


def test_validate_gfswave_inventory_requires_height_period_and_direction() -> None:
    request = GfsWaveRequest(
        cycle=datetime(2026, 7, 8, 12, tzinfo=timezone.utc),
        forecast_hour=3,
        bbox=norcal_bbox(),
    )

    inventory = validate_gfswave_inventory(SAMPLE_WCOAST_IDX, request)

    assert inventory.variables == (
        "DIRPW",
        "HTSGW",
        "PERPW",
        "SWDIR",
        "SWELL",
        "SWPER",
        "WIND",
        "WVDIR",
        "WVHGT",
        "WVPER",
    )

    with pytest.raises(GfsWaveInventoryValidationError, match="DIRPW"):
        validate_gfswave_inventory(MISSING_DIRECTION_IDX, request)


def test_select_latest_complete_cycle_falls_back_when_latest_cycle_is_missing() -> None:
    def fake_fetch(request: GfsWaveRequest) -> str:
        if request.cycle_hour == "12" and request.forecast_hour == 3:
            raise GfsWaveInventoryUnavailable("missing f003")
        if request.cycle_hour == "12":
            return SAMPLE_WCOAST_IDX
        if request.cycle_hour == "06":
            return SAMPLE_WCOAST_IDX
        raise GfsWaveInventoryUnavailable("unexpected candidate")

    plan = select_latest_complete_gfswave_cycle(
        now=datetime(2026, 7, 8, 14, 12, tzinfo=timezone.utc),
        forecast_hours=(0, 3),
        fetch_inventory_text=fake_fetch,
        max_cycles=2,
    )

    assert plan.cycle.isoformat() == "2026-07-08T06:00:00+00:00"
    assert plan.lead_hours == (0, 3)


def test_select_latest_complete_cycle_raises_when_no_candidate_is_available() -> None:
    def fake_fetch(request: GfsWaveRequest) -> str:
        raise GfsWaveInventoryUnavailable(f"missing {request.file_name}")

    with pytest.raises(GfsWaveCycleUnavailable, match="No complete GFSwave cycle found"):
        select_latest_complete_gfswave_cycle(
            now=datetime(2026, 7, 8, 14, 12, tzinfo=timezone.utc),
            forecast_hours=(0,),
            fetch_inventory_text=fake_fetch,
            max_cycles=1,
        )


def test_point_series_output_carries_values_and_artifact_metadata() -> None:
    cycle = datetime(2026, 7, 8, 12, tzinfo=timezone.utc)
    plan = build_gfswave_cycle_plan(cycle, forecast_hours=(0, 3))
    point = GfsWavePoint(point_id="obsf-central-offshore", lat=37.76, lon=-123.2)

    series = normalize_gfswave_point_series(
        plan,
        point,
        {
            0: {"HTSGW": 1.8, "PERPW": 14.0, "DIRPW": 285.0},
            3: {"HTSGW": 1.9, "PERPW": 13.5, "DIRPW": 287.0},
        },
    )

    first = series[0]
    assert first.source_id == "noaa-gfswave-wcoast-0p16"
    assert first.point_id == "obsf-central-offshore"
    assert first.wave_height_m == 1.8
    assert first.peak_period_s == 14.0
    assert first.primary_direction_deg == 285.0
    assert first.cycle == cycle
    assert first.lead_hour == 0
    assert first.forecast_time == cycle
    assert first.r2_key.endswith("/cycle=2026070812/lead=f000/norcal.grib2")

    second = series[1]
    assert second.forecast_time == cycle + timedelta(hours=3)
    assert second.lead_hour == 3
