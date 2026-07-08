from __future__ import annotations

import gzip
from datetime import datetime, timezone
from statistics import mean

import httpx
from pydantic import BaseModel, ConfigDict, Field


NDBC_HISTORY_URL = "https://www.ndbc.noaa.gov/data/historical/stdmet"


class NdbcWaveObservation(BaseModel):
    model_config = ConfigDict(frozen=True)

    station_id: str
    observed_at: datetime
    wave_height_m: float | None = Field(default=None, ge=0)
    dominant_period_s: float | None = Field(default=None, ge=0)
    mean_wave_direction_deg: int | None = Field(default=None, ge=0, le=360)


class NdbcBacktestSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    station_id: str
    started_at: datetime
    ended_at: datetime
    sample_count: int
    wave_height_sample_count: int
    dominant_period_sample_count: int
    direction_sample_count: int
    mean_wave_height_m: float | None
    mean_dominant_period_s: float | None
    mean_direction_deg: float | None


def ndbc_history_url(station_id: str, year: int) -> str:
    return f"{NDBC_HISTORY_URL}/{station_id}h{year}.txt.gz"


def _float_or_none(value: str) -> float | None:
    try:
        parsed = float(value)
    except ValueError:
        return None
    if parsed in (99.0, 99.00, 999.0, 9999.0):
        return None
    return parsed


def _int_or_none(value: str) -> int | None:
    try:
        parsed = int(float(value))
    except ValueError:
        return None
    if parsed in (99, 999, 9999):
        return None
    return parsed


def parse_ndbc_standard_met_history(station_id: str, text: str) -> tuple[NdbcWaveObservation, ...]:
    observations: list[NdbcWaveObservation] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 12:
            continue
        try:
            year, month, day, hour, minute = (int(parts[index]) for index in range(5))
            observed_at = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            continue
        observations.append(
            NdbcWaveObservation(
                station_id=station_id,
                observed_at=observed_at,
                wave_height_m=_float_or_none(parts[8]),
                dominant_period_s=_float_or_none(parts[9]),
                mean_wave_direction_deg=_int_or_none(parts[11]),
            )
        )
    return tuple(observations)


def summarize_ndbc_wave_history(
    station_id: str,
    observations: tuple[NdbcWaveObservation, ...],
) -> NdbcBacktestSummary:
    if not observations:
        raise ValueError(f"No NDBC observations parsed for {station_id}")

    wave_heights = [row.wave_height_m for row in observations if row.wave_height_m is not None]
    periods = [row.dominant_period_s for row in observations if row.dominant_period_s is not None]
    directions = [row.mean_wave_direction_deg for row in observations if row.mean_wave_direction_deg is not None]

    return NdbcBacktestSummary(
        station_id=station_id,
        started_at=min(row.observed_at for row in observations),
        ended_at=max(row.observed_at for row in observations),
        sample_count=len(observations),
        wave_height_sample_count=len(wave_heights),
        dominant_period_sample_count=len(periods),
        direction_sample_count=len(directions),
        mean_wave_height_m=round(mean(wave_heights), 3) if wave_heights else None,
        mean_dominant_period_s=round(mean(periods), 3) if periods else None,
        mean_direction_deg=round(mean(directions), 1) if directions else None,
    )


def fetch_ndbc_standard_met_history(station_id: str, year: int) -> str:
    response = httpx.get(ndbc_history_url(station_id, year), timeout=30.0)
    response.raise_for_status()
    return gzip.decompress(response.content).decode("utf-8", errors="replace")


def run_ndbc_history_backtest(station_id: str, year: int) -> NdbcBacktestSummary:
    text = fetch_ndbc_standard_met_history(station_id, year)
    return summarize_ndbc_wave_history(station_id, parse_ndbc_standard_met_history(station_id, text))
