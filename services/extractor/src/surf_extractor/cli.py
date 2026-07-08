from __future__ import annotations

from datetime import datetime, timezone

import click

from .feeds import GfsWaveRequest, latest_complete_cycle, norcal_bbox


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


@main.command("plan-gfswave-request")
@click.option("--forecast-hour", default=0, show_default=True, type=int)
def plan_gfswave_request(forecast_hour: int) -> None:
    """Build the NOAA/NOMADS URL for the current NorCal request."""
    request = GfsWaveRequest(
      cycle=latest_complete_cycle(),
      forecast_hour=forecast_hour,
      bbox=norcal_bbox(),
    )
    click.echo(request.nomads_filter_url())


if __name__ == "__main__":
    main()

