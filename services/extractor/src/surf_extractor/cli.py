from __future__ import annotations

import json
from datetime import datetime, timezone

import click

from .backtest import run_ndbc_history_backtest
from .feeds import (
    GFSWAVE_V1_FORECAST_HOURS,
    GfsWaveRequest,
    build_gfswave_cycle_plan,
    grib_tooling_status,
    latest_complete_cycle,
    norcal_bbox,
    select_latest_complete_gfswave_cycle,
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


@main.command("backtest-ndbc-history")
@click.option("--station-id", default="46026", show_default=True, help="NDBC station id.")
@click.option("--year", type=int, required=True, help="Historical stdmet year to fetch.")
def backtest_ndbc_history(station_id: str, year: int) -> None:
    """Summarize public NDBC historical wave observations for calibration."""
    summary = run_ndbc_history_backtest(station_id=station_id, year=year)
    click.echo(json.dumps(summary.model_dump(mode="json"), indent=2))


if __name__ == "__main__":
    main()
