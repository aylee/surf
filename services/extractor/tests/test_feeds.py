from datetime import datetime, timezone

from surf_extractor.feeds import GfsWaveRequest, latest_complete_cycle, norcal_bbox


def test_gfswave_url_contains_bbox_and_variables() -> None:
    request = GfsWaveRequest(
        cycle=datetime(2026, 7, 8, 12, tzinfo=timezone.utc),
        forecast_hour=6,
        bbox=norcal_bbox(),
    )

    url = request.nomads_filter_url()

    assert "filter_gfswave.pl" in url
    assert "f006" in url
    assert "leftlon=-124.0" in url
    assert "var_HTSGW=on" in url
    assert "var_PERPW=on" in url


def test_latest_complete_cycle_rounds_to_six_hour_boundary() -> None:
    cycle = latest_complete_cycle(datetime(2026, 7, 8, 14, 12, tzinfo=timezone.utc))
    assert cycle.isoformat() == "2026-07-08T12:00:00+00:00"

