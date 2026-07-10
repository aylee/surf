from datetime import datetime, timezone

import httpx
import pytest

from surf_extractor.backtest import EvaluationConfig, WaveForecast
from surf_extractor.cdip import (
    CdipDatasetInvalid,
    CdipDatasetUnavailable,
    CdipMopMapping,
    apply_fixed_height_transform,
    build_cdip_opendap_ascii_url,
    cdip_mop_values_from_ascii,
    evaluate_fixed_transform_against_cdip,
    fetch_cdip_mop_metadata,
    fetch_cdip_mop_series,
    parse_cdip_mop_metadata,
    parse_cdip_opendap_ascii,
)


UTC = timezone.utc
DATASET = (
    "https://thredds.cdip.ucsd.edu/thredds/dodsC/"
    "cdip/model/MOP_alongshore/M0171_nowcast.nc"
)
DDS = """\
Dataset {
  Int32 waveTime[waveTime = 3];
  Float32 waveHs[waveTime = 3];
  Float32 waveTp[waveTime = 3];
  Float32 waveDp[waveTime = 3];
} sample;
"""
DAS = """\
Attributes {
  NC_GLOBAL {
    Float64 geospatial_lat_min 38.93339;
    Float64 geospatial_lon_min -123.73723;
    String time_coverage_start "2025-03-31T23:30:00Z";
    String time_coverage_end "2026-05-07T11:30:00Z";
    String date_issued "2026-05-07T12:18:48Z";
    String license "These data may be redistributed and used without restriction.";
  }
}
"""
ASCII = """\
Dataset {
    Int32 waveTime[waveTime = 3];
    Float32 waveHs[waveTime = 3];
    Float32 waveTp[waveTime = 3];
    Float32 waveDp[waveTime = 3];
} sample;
---------------------------------------------
waveTime[3]
1735689600, 1735693200, 1735696800

waveHs[3]
2.0, -999.99, 3.0

waveTp[3]
10.0, 11.0, 12.0

waveDp[3]
359.0, 1.0, 280.0
"""


def mapping() -> CdipMopMapping:
    return CdipMopMapping(
        spot_id="test-spot",
        cdip_point_id="M0171",
        dataset_url=DATASET,
        height_scale=0.5,
    )


def test_cdip_ascii_url_is_bounded_and_explicit() -> None:
    url = build_cdip_opendap_ascii_url(
        f"{DATASET}.html",
        start_index=10,
        stop_index=20,
        stride=2,
        variables=("waveTime", "waveHs"),
    )

    assert url == f"{DATASET}.ascii?waveTime[10:2:20],waveHs[10:2:20]"
    with pytest.raises(ValueError, match="stop_index"):
        build_cdip_opendap_ascii_url(DATASET, start_index=2, stop_index=1)


def test_cdip_metadata_parser_preserves_provenance() -> None:
    metadata = parse_cdip_mop_metadata(
        cdip_point_id="M0171",
        dataset_url=DATASET,
        dds_text=DDS,
        das_text=DAS,
    )

    assert metadata.variables == ("waveTime", "waveHs", "waveTp", "waveDp")
    assert metadata.latitude == 38.93339
    assert metadata.longitude == -123.73723
    assert metadata.time_coverage_start == datetime(2025, 3, 31, 23, 30, tzinfo=UTC)
    assert metadata.date_issued == datetime(2026, 5, 7, 12, 18, 48, tzinfo=UTC)
    assert metadata.license and "without restriction" in metadata.license


def test_cdip_metadata_requires_time_and_height_variables() -> None:
    with pytest.raises(CdipDatasetInvalid, match="waveHs"):
        parse_cdip_mop_metadata(
            cdip_point_id="M0171",
            dataset_url=DATASET,
            dds_text="Dataset { Int32 waveTime[waveTime = 3]; } sample;",
            das_text=DAS,
        )


def test_cdip_ascii_parser_and_fill_values() -> None:
    arrays = parse_cdip_opendap_ascii(ASCII)
    values = cdip_mop_values_from_ascii("M0171", ASCII)

    assert arrays["waveHs"] == (2, -999.99, 3)
    assert values[0].observed_at == datetime(2025, 1, 1, tzinfo=UTC)
    assert values[0].wave_height_m == 2
    assert values[1].wave_height_m is None
    assert values[2].peak_period_s == 12
    assert values[0].direction_deg == 359


def test_cdip_ascii_parser_rejects_inconsistent_arrays() -> None:
    inconsistent = ASCII.replace("waveHs[3]\n2.0, -999.99, 3.0", "waveHs[2]\n2.0, 3.0")
    with pytest.raises(CdipDatasetInvalid, match="inconsistent lengths"):
        cdip_mop_values_from_ascii("M0171", inconsistent)


def test_cdip_fetchers_are_mockable_and_network_free() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.path.endswith(".dds"):
            return httpx.Response(200, text=DDS, request=request)
        if request.url.path.endswith(".das"):
            return httpx.Response(200, text=DAS, request=request)
        if request.url.path.endswith(".ascii"):
            return httpx.Response(200, text=ASCII, request=request)
        return httpx.Response(404, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        metadata = fetch_cdip_mop_metadata(mapping(), client=client)
        values = fetch_cdip_mop_series(
            mapping(),
            start_index=0,
            stop_index=2,
            client=client,
        )

    assert metadata.cdip_point_id == "M0171"
    assert len(values) == 3
    assert any(url.endswith(".dds") for url in seen)
    assert any(".ascii?waveTime" in url for url in seen)


def test_cdip_unavailable_response_is_actionable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(CdipDatasetUnavailable, match="HTTP 404"):
            fetch_cdip_mop_metadata(mapping(), client=client)


def test_fixed_transform_evaluation_is_labeled_as_proxy_not_truth() -> None:
    source_values = cdip_mop_values_from_ascii("M0171", ASCII)
    forecasts = [
        WaveForecast(
            source_id="nws-raw",
            issued_at=datetime(2024, 12, 31, 18, tzinfo=UTC),
            valid_at=datetime(2025, 1, 1, tzinfo=UTC),
            wave_height_m=4,
            peak_period_s=10,
            direction_deg=1,
        ),
        WaveForecast(
            source_id="nws-raw",
            issued_at=datetime(2024, 12, 31, 18, tzinfo=UTC),
            valid_at=datetime(2025, 1, 1, 2, tzinfo=UTC),
            wave_height_m=8,
            peak_period_s=12,
            direction_deg=280,
        ),
    ]

    transformed = apply_fixed_height_transform(forecasts, mapping())
    report = evaluate_fixed_transform_against_cdip(
        forecasts,
        source_values,
        mapping(),
        config=EvaluationConfig(match_tolerance_minutes=1),
    )

    assert [row.wave_height_m for row in transformed] == [2, 4]
    assert report.metrics.wave_height.matched_count == 2
    assert report.metrics.wave_height.mae == 0.5
    assert report.context["reference_kind"] == "modeled_nearshore_proxy"
    assert report.context["reference_is_breaking_wave_truth"] is False
