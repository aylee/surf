from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import cast

import click
import httpx
from pydantic import ValidationError

from .backtest import (
    EvaluationConfig,
    NdbcError,
    PhysicalEvaluationReport,
    WaveForecast,
    WaveObservation,
    evaluate_physical_forecasts,
    load_jsonl,
    run_ndbc_history_summary,
    write_evaluation_artifacts,
)
from .cdip import (
    CdipError,
    CdipMopMapping,
    evaluate_fixed_transform_against_cdip,
    fetch_cdip_mop_metadata,
    fetch_cdip_mop_series,
    fetch_cdip_mop_time_window,
)
from .feeds import (
    GFSWAVE_V1_FORECAST_HOURS,
    GfsWaveRequest,
    build_gfswave_cycle_plan,
    grib_tooling_status,
    latest_complete_cycle,
    norcal_bbox,
    select_latest_complete_gfswave_cycle,
)
from .ndfd_history import (
    CfgribNdfdPointExtractor,
    NdfdHistoryError,
    NdfdMopHistoryMapping,
    NdfdS3ArchiveClient,
    evaluate_ndfd_mop_history,
    extract_ndfd_point_forecasts,
    require_ndfd_grib_tooling,
    select_ndfd_archive_snapshots,
    write_ndfd_mop_history_artifacts,
)


@click.group()
def main() -> None:
    """surf public-data extraction helpers."""


@main.command("inspect-fixtures")
def inspect_fixtures() -> None:
    """Print the bootstrap fixture/source plan."""
    cycle = latest_complete_cycle(datetime(2026, 7, 8, 12, 30, tzinfo=timezone.utc))
    request = GfsWaveRequest(cycle=cycle, forecast_hour=0, bbox=norcal_bbox())
    click.echo("bootstrap extractor fixture plan")
    click.echo(f"cycle={cycle.isoformat()}")
    click.echo(f"nomads={request.nomads_filter_url()}")
    click.echo(f"inventory={request.inventory_url()}")
    click.echo(f"r2_key={request.r2_key}")


@main.command("plan-gfswave-request")
@click.option("--forecast-hour", default=0, show_default=True, type=int)
@click.option("--json-output", is_flag=True, help="Print the planned artifact as JSON.")
def plan_gfswave_request(forecast_hour: int, json_output: bool) -> None:
    """Build the NOAA/NOMADS URL for the current NorCal request."""
    request = GfsWaveRequest(
        cycle=latest_complete_cycle(),
        forecast_hour=forecast_hour,
        bbox=norcal_bbox(),
    )
    if json_output:
        click.echo(json.dumps(request.artifact_plan().model_dump(mode="json"), indent=2))
        return
    click.echo(request.nomads_filter_url())


@main.command("plan-gfswave-cycle")
@click.option(
    "--forecast-hour",
    "forecast_hours",
    multiple=True,
    type=int,
    help="Forecast hour to include. Defaults to v1 f000..f072 every 3h.",
)
def plan_gfswave_cycle(forecast_hours: tuple[int, ...]) -> None:
    """Print the planned NOAA GFSwave artifacts for the latest nominal cycle."""
    cycle = latest_complete_cycle()
    plan = build_gfswave_cycle_plan(
        cycle,
        forecast_hours=forecast_hours or GFSWAVE_V1_FORECAST_HOURS,
    )
    click.echo(json.dumps(plan.model_dump(mode="json"), indent=2))


@main.command("validate-gfswave-cycle")
@click.option(
    "--forecast-hour",
    "forecast_hours",
    multiple=True,
    type=int,
    help="Forecast hour to validate. Defaults to v1 f000..f072 every 3h.",
)
def validate_gfswave_cycle(forecast_hours: tuple[int, ...]) -> None:
    """Probe NOMADS inventories and select the latest complete v1 cycle."""
    plan = select_latest_complete_gfswave_cycle(
        forecast_hours=forecast_hours or GFSWAVE_V1_FORECAST_HOURS
    )
    click.echo(json.dumps(plan.model_dump(mode="json"), indent=2))


@main.command("grib-tooling-status")
def print_grib_tooling_status() -> None:
    """Report whether local GRIB point-extraction tooling is available."""
    status = grib_tooling_status()
    click.echo(json.dumps(status.model_dump(mode="json"), indent=2))


@main.command("summarize-ndbc-history")
@click.option("--station-id", default="46026", show_default=True, help="NDBC station id.")
@click.option("--year", type=int, required=True, help="Historical stdmet year to fetch.")
def summarize_ndbc_history(station_id: str, year: int) -> None:
    """Describe NDBC observations; this is not forecast-accuracy testing."""
    try:
        summary = run_ndbc_history_summary(station_id=station_id, year=year)
    except NdbcError as error:
        raise click.ClickException(str(error)) from error
    click.echo(json.dumps(summary.model_dump(mode="json"), indent=2))


def _evaluation_config(
    *,
    match_tolerance_minutes: float,
    allow_future_observations: bool,
    wave_height_tolerance_m: float,
    peak_period_tolerance_s: float,
    direction_tolerance_deg: float,
) -> EvaluationConfig:
    try:
        return EvaluationConfig(
            match_tolerance_minutes=match_tolerance_minutes,
            allow_future_observations=allow_future_observations,
            wave_height_tolerance_m=wave_height_tolerance_m,
            peak_period_tolerance_s=peak_period_tolerance_s,
            direction_tolerance_deg=direction_tolerance_deg,
        )
    except ValidationError as error:
        raise click.BadParameter(str(error)) from error


def _emit_evaluation(
    report: PhysicalEvaluationReport,
    *,
    output_json: Path,
    samples_jsonl: Path | None,
) -> None:
    if output_json == Path("-"):
        click.echo(
            write_evaluation_artifacts(report, samples_jsonl_path=samples_jsonl)
        )
        return
    write_evaluation_artifacts(
        report,
        json_path=output_json,
        samples_jsonl_path=samples_jsonl,
    )


def _load_forecasts(path: Path) -> tuple[WaveForecast, ...]:
    try:
        return cast(tuple[WaveForecast, ...], load_jsonl(path, WaveForecast))
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error


def _load_observations(path: Path) -> tuple[WaveObservation, ...]:
    try:
        return cast(tuple[WaveObservation, ...], load_jsonl(path, WaveObservation))
    except (OSError, ValueError) as error:
        raise click.ClickException(str(error)) from error


def _evaluation_options(function):  # type: ignore[no-untyped-def]
    options = [
        click.option(
            "--match-tolerance-minutes",
            type=float,
            default=30.0,
            show_default=True,
            help="Maximum observation-time difference accepted for a match.",
        ),
        click.option(
            "--allow-future-observations",
            is_flag=True,
            help="Allow the nearest observation after valid_at; off is no-lookahead.",
        ),
        click.option(
            "--wave-height-tolerance-m",
            type=float,
            default=0.5,
            show_default=True,
        ),
        click.option(
            "--peak-period-tolerance-s",
            type=float,
            default=2.0,
            show_default=True,
        ),
        click.option(
            "--direction-tolerance-deg",
            type=float,
            default=22.5,
            show_default=True,
        ),
        click.option(
            "--output-json",
            type=click.Path(path_type=Path),
            default=Path("-"),
            show_default=True,
            help="Summary + samples JSON path, or '-' for stdout.",
        ),
        click.option(
            "--samples-jsonl",
            type=click.Path(path_type=Path),
            help="Optional reproducible one-sample-per-line artifact.",
        ),
    ]
    for option in reversed(options):
        function = option(function)
    return function


@main.command("evaluate-jsonl")
@click.option(
    "--forecast-jsonl",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--observation-jsonl",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@_evaluation_options
def evaluate_jsonl(
    forecast_jsonl: Path,
    observation_jsonl: Path,
    match_tolerance_minutes: float,
    allow_future_observations: bool,
    wave_height_tolerance_m: float,
    peak_period_tolerance_s: float,
    direction_tolerance_deg: float,
    output_json: Path,
    samples_jsonl: Path | None,
) -> None:
    """Evaluate immutable issued forecasts against time-aligned observations."""

    config = _evaluation_config(
        match_tolerance_minutes=match_tolerance_minutes,
        allow_future_observations=allow_future_observations,
        wave_height_tolerance_m=wave_height_tolerance_m,
        peak_period_tolerance_s=peak_period_tolerance_s,
        direction_tolerance_deg=direction_tolerance_deg,
    )
    report = evaluate_physical_forecasts(
        _load_forecasts(forecast_jsonl),
        _load_observations(observation_jsonl),
        config=config,
        context={
            "forecast_input": str(forecast_jsonl),
            "observation_input": str(observation_jsonl),
        },
    )
    _emit_evaluation(report, output_json=output_json, samples_jsonl=samples_jsonl)


@main.command("evaluate-cdip-transform")
@click.option(
    "--mapping-json",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Spot/CDIP dataset mapping with the fixed height scale under test.",
)
@click.option(
    "--forecast-jsonl",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Immutable issued offshore forecasts; wave_height_m is scaled.",
)
@click.option("--start-index", type=int, required=True, help="First CDIP waveTime index.")
@click.option("--stop-index", type=int, required=True, help="Last CDIP waveTime index.")
@click.option("--stride", type=int, default=1, show_default=True)
@_evaluation_options
def evaluate_cdip_transform(
    mapping_json: Path,
    forecast_jsonl: Path,
    start_index: int,
    stop_index: int,
    stride: int,
    match_tolerance_minutes: float,
    allow_future_observations: bool,
    wave_height_tolerance_m: float,
    peak_period_tolerance_s: float,
    direction_tolerance_deg: float,
    output_json: Path,
    samples_jsonl: Path | None,
) -> None:
    """Compare a fixed spot height scale to a supplied CDIP MOP reference."""

    try:
        mapping = CdipMopMapping.model_validate_json(mapping_json.read_text())
    except (OSError, ValidationError) as error:
        raise click.ClickException(f"Invalid mapping {mapping_json}: {error}") from error
    config = _evaluation_config(
        match_tolerance_minutes=match_tolerance_minutes,
        allow_future_observations=allow_future_observations,
        wave_height_tolerance_m=wave_height_tolerance_m,
        peak_period_tolerance_s=peak_period_tolerance_s,
        direction_tolerance_deg=direction_tolerance_deg,
    )
    try:
        metadata = fetch_cdip_mop_metadata(mapping)
        variables = tuple(
            variable
            for variable in ("waveTime", "waveHs", "waveTp", "waveDp")
            if variable in metadata.variables
        )
        cdip_values = fetch_cdip_mop_series(
            mapping,
            start_index=start_index,
            stop_index=stop_index,
            stride=stride,
            variables=variables,
        )
    except (CdipError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    report = evaluate_fixed_transform_against_cdip(
        _load_forecasts(forecast_jsonl),
        cdip_values,
        mapping,
        config=config,
        metadata=metadata,
    )
    _emit_evaluation(report, output_json=output_json, samples_jsonl=samples_jsonl)


def _parse_utc_option(value: str, *, option_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise click.BadParameter(
            f"must be an ISO-8601 timestamp with UTC offset: {value}",
            param_hint=option_name,
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise click.BadParameter(
            f"must include a UTC offset: {value}",
            param_hint=option_name,
        )
    return parsed.astimezone(timezone.utc)


@main.command("evaluate-ndfd-mop-history")
@click.option(
    "--mapping-json",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
    help="Target coordinate, MOP nowcast URL, current scale, and distance guard.",
)
@click.option(
    "--issue-at",
    "issue_ats",
    multiple=True,
    required=True,
    help="Strictly chronological UTC as-of snapshot; repeat for each history cycle.",
)
@click.option(
    "--train-cutoff",
    required=True,
    help="UTC issue-time cutoff; later issued forecasts form the holdout.",
)
@click.option("--max-cycle-age-hours", type=float, default=12.0, show_default=True)
@click.option("--max-object-bytes", type=int, default=25_000_000, show_default=True)
@click.option("--max-mop-records", type=int, default=50_000, show_default=True)
@click.option("--network-timeout-seconds", type=float, default=30.0, show_default=True)
@_evaluation_options
def evaluate_ndfd_mop_history_command(
    mapping_json: Path,
    issue_ats: tuple[str, ...],
    train_cutoff: str,
    max_cycle_age_hours: float,
    max_object_bytes: int,
    max_mop_records: int,
    network_timeout_seconds: float,
    match_tolerance_minutes: float,
    allow_future_observations: bool,
    wave_height_tolerance_m: float,
    peak_period_tolerance_s: float,
    direction_tolerance_deg: float,
    output_json: Path,
    samples_jsonl: Path | None,
) -> None:
    """Backtest archived NDFD wave height against a CDIP MOP nowcast proxy."""

    try:
        mapping = NdfdMopHistoryMapping.model_validate_json(mapping_json.read_text())
    except (OSError, ValidationError) as error:
        raise click.ClickException(f"Invalid mapping {mapping_json}: {error}") from error
    requested = tuple(
        _parse_utc_option(value, option_name="--issue-at") for value in issue_ats
    )
    cutoff = _parse_utc_option(train_cutoff, option_name="--train-cutoff")
    config = _evaluation_config(
        match_tolerance_minutes=match_tolerance_minutes,
        allow_future_observations=allow_future_observations,
        wave_height_tolerance_m=wave_height_tolerance_m,
        peak_period_tolerance_s=peak_period_tolerance_s,
        direction_tolerance_deg=direction_tolerance_deg,
    )
    if network_timeout_seconds <= 0:
        raise click.BadParameter(
            "must be positive",
            param_hint="--network-timeout-seconds",
        )
    try:
        require_ndfd_grib_tooling()
        with httpx.Client(
            timeout=network_timeout_seconds,
            follow_redirects=True,
        ) as client:
            archive = NdfdS3ArchiveClient(client)
            snapshots = select_ndfd_archive_snapshots(
                requested,
                archive,
                max_cycle_age=timedelta(hours=max_cycle_age_hours),
            )
            point_forecasts = extract_ndfd_point_forecasts(
                snapshots,
                archive,
                CfgribNdfdPointExtractor(),
                mapping,
                max_object_bytes=max_object_bytes,
            )
            cdip_mapping = mapping.cdip_mapping()
            metadata = fetch_cdip_mop_metadata(cdip_mapping, client=client)
            cdip_values = fetch_cdip_mop_time_window(
                cdip_mapping,
                metadata,
                started_at=min(row.valid_at for row in point_forecasts),
                ended_at=max(row.valid_at for row in point_forecasts),
                padding=timedelta(minutes=match_tolerance_minutes),
                max_records=max_mop_records,
                client=client,
            )
    except (NdfdHistoryError, CdipError, ValueError) as error:
        raise click.ClickException(str(error)) from error
    try:
        report = evaluate_ndfd_mop_history(
            point_forecasts,
            cdip_values,
            mapping,
            train_cutoff=cutoff,
            snapshots=snapshots,
            cdip_metadata=metadata,
            config=config,
        )
    except ValueError as error:
        raise click.ClickException(str(error)) from error
    if output_json == Path("-"):
        click.echo(
            write_ndfd_mop_history_artifacts(
                report,
                samples_jsonl_path=samples_jsonl,
            )
        )
        return
    write_ndfd_mop_history_artifacts(
        report,
        json_path=output_json,
        samples_jsonl_path=samples_jsonl,
    )


if __name__ == "__main__":
    main()
