from datetime import datetime, timezone

import pytest

from surf_extractor.backtest import (
    ndbc_history_url,
    parse_ndbc_standard_met_history,
    summarize_ndbc_wave_history,
)


SAMPLE_NDBC_HISTORY = """\
#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
#yr mo dy hr mn degT m/s m/s m sec sec degT hPa degC degC degC nmi hPa ft
2025 01 01 00 00 310 7.0 9.0 2.1 14 9.5 285 1018.0 12.0 11.0 9.0 99 99 99
2025 01 01 01 00 315 8.0 10.0 2.4 13 9.1 287 1018.2 12.0 11.0 9.0 99 99 99
2025 01 01 02 00 999 99.0 99.0 99.0 99 99 999 1018.4 12.0 11.0 9.0 99 99 99
"""


def test_ndbc_history_url() -> None:
    assert ndbc_history_url("46026", 2025).endswith("/46026h2025.txt.gz")


def test_parse_and_summarize_ndbc_history() -> None:
    observations = parse_ndbc_standard_met_history("46026", SAMPLE_NDBC_HISTORY)

    assert len(observations) == 3
    assert observations[0].observed_at == datetime(2025, 1, 1, 0, 0, tzinfo=timezone.utc)
    assert observations[0].wave_height_m == 2.1
    assert observations[2].wave_height_m is None
    assert observations[2].mean_wave_direction_deg is None

    summary = summarize_ndbc_wave_history("46026", observations)

    assert summary.sample_count == 3
    assert summary.wave_height_sample_count == 2
    assert summary.dominant_period_sample_count == 2
    assert summary.direction_sample_count == 2
    assert summary.mean_wave_height_m == 2.25
    assert summary.mean_dominant_period_s == 13.5
    assert summary.mean_direction_deg == 286.0


def test_summarize_ndbc_history_rejects_empty_input() -> None:
    with pytest.raises(ValueError, match="No NDBC observations"):
        summarize_ndbc_wave_history("46026", ())
