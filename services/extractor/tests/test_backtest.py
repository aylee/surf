import gzip
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from surf_extractor.backtest import (
    EvaluationConfig,
    NdbcArchiveInvalid,
    NdbcArchiveUnavailable,
    NdbcParseError,
    WaveForecast,
    WaveObservation,
    circular_difference_degrees,
    circular_mean_degrees,
    evaluate_physical_forecasts,
    fetch_ndbc_standard_met_history,
    load_jsonl,
    match_forecasts_to_observations,
    ndbc_history_url,
    parse_ndbc_standard_met_history,
    summarize_ndbc_wave_history,
    write_evaluation_artifacts,
)


UTC = timezone.utc

SAMPLE_NDBC_HISTORY = """\
#YY MM DD hh mm DPD WVHT MWD WDIR WSPD
#yr mo dy hr mn sec m degT degT m/s
2025 01 01 00 00 14 2.1 359 310 7.0
2025 01 01 01 00 13 2.4 1 315 8.0
2025 01 01 02 00 99 99.0 999 999 99.0
"""


def dt(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2025, 1, day, hour, minute, tzinfo=UTC)


def test_ndbc_history_url() -> None:
    assert ndbc_history_url("46026", 2025).endswith("/46026h2025.txt.gz")


def test_header_aware_ndbc_parser_and_circular_summary() -> None:
    observations = parse_ndbc_standard_met_history("46026", SAMPLE_NDBC_HISTORY)

    assert len(observations) == 3
    assert observations[0].observed_at == dt(1, 0)
    assert observations[0].wave_height_m == 2.1
    assert observations[0].dominant_period_s == 14
    assert observations[2].wave_height_m is None
    assert observations[2].mean_wave_direction_deg is None

    summary = summarize_ndbc_wave_history("46026", observations)

    assert summary.sample_count == 3
    assert summary.wave_height_sample_count == 2
    assert summary.dominant_period_sample_count == 2
    assert summary.direction_sample_count == 2
    assert summary.mean_wave_height_m == 2.25
    assert summary.mean_dominant_period_s == 13.5
    assert summary.circular_mean_direction_deg == 0.0


def test_parser_supports_old_hourly_header_without_minute() -> None:
    text = """\
#YY MM DD hh WVHT DPD MWD
#yr mo dy hr m sec degT
99 12 31 23 1.2 10 99
"""
    observation = parse_ndbc_standard_met_history("old", text)[0]

    assert observation.observed_at == datetime(1999, 12, 31, 23, tzinfo=UTC)
    assert observation.mean_wave_direction_deg == 99


def test_parser_rejects_missing_schema_and_empty_data() -> None:
    with pytest.raises(NdbcParseError, match="column header"):
        parse_ndbc_standard_met_history("46026", "2025 01 01 00 00 2.1")

    with pytest.raises(NdbcParseError, match="No NDBC observations"):
        parse_ndbc_standard_met_history(
            "46026",
            "#YY MM DD hh mm WVHT\n#yr mo dy hr mn m\ninvalid row",
        )


def test_summarize_ndbc_history_rejects_empty_input() -> None:
    with pytest.raises(ValueError, match="No NDBC observations"):
        summarize_ndbc_wave_history("46026", ())


def test_circular_math_handles_north_wrap_and_opposite_ambiguity() -> None:
    assert circular_mean_degrees([359, 1]) == pytest.approx(0)
    assert circular_mean_degrees([90, 270]) is None
    assert circular_difference_degrees(5, 355) == 10
    assert circular_difference_degrees(355, 5) == -10


def test_unavailable_ndbc_archive_has_actionable_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(NdbcArchiveUnavailable, match=r"46012.*2025.*HTTP 404"):
            fetch_ndbc_standard_met_history("46012", 2025, client=client)


def test_invalid_ndbc_gzip_is_reported() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not gzip", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(NdbcArchiveInvalid, match="not valid gzip"):
            fetch_ndbc_standard_met_history("46026", 2025, client=client)


def test_valid_ndbc_gzip_is_decoded() -> None:
    body = gzip.compress(SAMPLE_NDBC_HISTORY.encode())

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert fetch_ndbc_standard_met_history("46026", 2025, client=client).startswith(
            "#YY"
        )


def test_forecast_requires_immutable_no_lookahead_issuance() -> None:
    with pytest.raises(ValidationError, match="retrospective"):
        WaveForecast(
            source_id="model",
            issued_at=dt(1, 7),
            valid_at=dt(1, 6),
            wave_height_m=2,
        )

    with pytest.raises(ValidationError, match="UTC offset"):
        WaveForecast(
            source_id="model",
            issued_at=datetime(2025, 1, 1),
            valid_at=dt(1, 6),
            wave_height_m=2,
        )


def test_normalized_json_aliases_are_supported() -> None:
    forecast = WaveForecast.model_validate(
        {
            "source_id": "gfs",
            "model_cycle_at": "2025-01-01T00:00:00Z",
            "forecast_at": "2025-01-01T06:00:00Z",
            "offshore_height_m": 2.2,
            "primary_direction_deg": 300,
        }
    )
    observation = WaveObservation.model_validate(
        {
            "source_id": "ndbc",
            "observed_at": "2025-01-01T06:00:00Z",
            "dominant_period_s": 12,
            "mean_wave_direction_deg": 299,
        }
    )

    assert forecast.wave_height_m == 2.2
    assert forecast.valid_at == dt(1, 6)
    assert observation.peak_period_s == 12

    with pytest.raises(ValidationError, match="set wave_height_m explicitly"):
        WaveForecast.model_validate(
            {
                "source_id": "nws",
                "model_cycle_at": "2025-01-01T00:00:00Z",
                "forecast_at": "2025-01-01T06:00:00Z",
                "offshore_height_m": 2.2,
                "nearshore_height_m": 1.4,
            }
        )


def test_time_match_defaults_to_no_future_observations() -> None:
    forecast = WaveForecast(
        source_id="model",
        issued_at=dt(1, 0),
        valid_at=dt(1, 6),
        wave_height_m=2,
    )
    before = WaveObservation(
        observation_id="before",
        source_id="buoy",
        observed_at=dt(1, 5, 40),
        wave_height_m=1.8,
    )
    after = WaveObservation(
        observation_id="after",
        source_id="buoy",
        observed_at=dt(1, 6, 5),
        wave_height_m=2.1,
    )

    no_lookahead = match_forecasts_to_observations(
        [forecast],
        [after, before],
        EvaluationConfig(match_tolerance_minutes=30),
    )[0]
    nearest = match_forecasts_to_observations(
        [forecast],
        [after, before],
        EvaluationConfig(
            match_tolerance_minutes=30,
            allow_future_observations=True,
        ),
    )[0]

    assert no_lookahead.observation_id == "before"
    assert no_lookahead.observation_lag_minutes == -20
    assert nearest.observation_id == "after"
    assert nearest.observation_lag_minutes == 5


def test_evaluator_reports_linear_circular_coverage_and_lead_buckets() -> None:
    forecasts = [
        WaveForecast(
            forecast_id="f0",
            source_id="model",
            issued_at=dt(1, 0),
            valid_at=dt(1, 6),
            wave_height_m=2,
            peak_period_s=12,
            direction_deg=350,
        ),
        WaveForecast(
            forecast_id="f1",
            source_id="model",
            issued_at=dt(1, 0),
            valid_at=dt(1, 18),
            wave_height_m=3,
            peak_period_s=10,
            direction_deg=10,
        ),
        WaveForecast(
            forecast_id="f2",
            source_id="model",
            issued_at=dt(1, 0),
            valid_at=dt(2, 6),
            wave_height_m=4,
        ),
    ]
    observations = [
        WaveObservation(
            source_id="buoy",
            observed_at=dt(1, 6),
            wave_height_m=1.5,
            peak_period_s=11,
            direction_deg=10,
        ),
        WaveObservation(
            source_id="buoy",
            observed_at=dt(1, 18),
            wave_height_m=3.5,
            peak_period_s=13,
            direction_deg=350,
        ),
    ]

    report = evaluate_physical_forecasts(forecasts, observations)

    assert report.schema_version == "surf-physical-evaluation/v1"
    assert report.metrics.forecast_count == 3
    assert report.metrics.time_matched_count == 2
    assert report.metrics.time_match_coverage == pytest.approx(2 / 3, abs=1e-6)
    assert report.metrics.wave_height.eligible_forecast_count == 3
    assert report.metrics.wave_height.matched_count == 2
    assert report.metrics.wave_height.coverage == pytest.approx(2 / 3, abs=1e-6)
    assert report.metrics.wave_height.mae == 0.5
    assert report.metrics.wave_height.rmse == 0.5
    assert report.metrics.wave_height.bias == 0
    assert report.metrics.wave_height.within_tolerance_rate == 1
    assert report.metrics.peak_period.mae == 2
    assert report.metrics.peak_period.rmse == pytest.approx(5**0.5, abs=1e-6)
    assert report.metrics.peak_period.bias == -1
    assert report.metrics.peak_period.within_tolerance_rate == 0.5
    assert report.metrics.direction.error_kind == "circular_degrees"
    assert report.metrics.direction.mae == 20
    assert report.metrics.direction.bias == 0
    assert report.metrics.direction.within_tolerance_rate == 1
    bucket_counts = {
        bucket.bucket: bucket.metrics.forecast_count for bucket in report.lead_buckets
    }
    assert bucket_counts["0-12h"] == 1
    assert bucket_counts["12-24h"] == 1
    assert bucket_counts["24-48h"] == 1


def test_tolerance_boundary_and_unmatched_rows_are_preserved() -> None:
    forecast = WaveForecast(
        source_id="model",
        issued_at=dt(1, 0),
        valid_at=dt(1, 6),
        wave_height_m=2,
    )
    observation = WaveObservation(
        source_id="buoy",
        observed_at=dt(1, 5, 30),
        wave_height_m=2,
    )
    matched = evaluate_physical_forecasts(
        [forecast],
        [observation],
        config=EvaluationConfig(match_tolerance_minutes=30),
    )
    unmatched = evaluate_physical_forecasts(
        [forecast],
        [observation.model_copy(update={"observed_at": dt(1, 5, 29)})],
        config=EvaluationConfig(match_tolerance_minutes=30),
    )

    assert matched.samples[0].observed_at is not None
    assert unmatched.samples[0].observed_at is None
    assert unmatched.metrics.time_match_coverage == 0


def test_json_and_jsonl_artifacts_are_reproducible(tmp_path: Path) -> None:
    report = evaluate_physical_forecasts(
        [
            WaveForecast(
                source_id="model",
                issued_at=dt(1, 0),
                valid_at=dt(1, 6),
                wave_height_m=2,
            )
        ],
        [
            WaveObservation(
                source_id="buoy",
                observed_at=dt(1, 6),
                wave_height_m=1.5,
            )
        ],
    )
    json_path = tmp_path / "evaluation.json"
    jsonl_path = tmp_path / "samples.jsonl"

    first = write_evaluation_artifacts(
        report,
        json_path=json_path,
        samples_jsonl_path=jsonl_path,
    )
    second = write_evaluation_artifacts(report)

    assert first == second
    assert json.loads(json_path.read_text())["metrics"]["wave_height"]["mae"] == 0.5
    assert len(jsonl_path.read_text().splitlines()) == 1


def test_load_jsonl_reports_source_line(tmp_path: Path) -> None:
    path = tmp_path / "forecasts.jsonl"
    path.write_text("{}\nnot json\n")

    with pytest.raises(ValueError, match=r"forecasts\.jsonl:1"):
        load_jsonl(path, WaveForecast)
