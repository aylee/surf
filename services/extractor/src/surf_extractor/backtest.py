from __future__ import annotations

import gzip
import json
import math
from bisect import bisect_right
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean, median
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, model_validator


NDBC_HISTORY_URL = "https://www.ndbc.noaa.gov/data/historical/stdmet"
EVALUATION_SCHEMA_VERSION = "surf-physical-evaluation/v1"


class NdbcError(RuntimeError):
    """Base error for NDBC history access and parsing."""


class NdbcArchiveUnavailable(NdbcError):
    """Raised when an NDBC annual archive cannot be retrieved."""

    def __init__(
        self,
        *,
        station_id: str,
        year: int,
        url: str,
        status_code: int | None = None,
        detail: str | None = None,
    ) -> None:
        status = f" (HTTP {status_code})" if status_code is not None else ""
        suffix = f": {detail}" if detail else ""
        super().__init__(
            f"NDBC standard-meteorological archive is unavailable for "
            f"{station_id} in {year}{status}{suffix}. URL: {url}"
        )
        self.station_id = station_id
        self.year = year
        self.url = url
        self.status_code = status_code


class NdbcArchiveInvalid(NdbcError):
    """Raised when an NDBC annual archive is present but cannot be decoded."""


class NdbcParseError(NdbcError):
    """Raised when a standard-meteorological file has no usable schema/data."""


def _utc_datetime(value: datetime, *, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must include a UTC offset")
    return value.astimezone(timezone.utc)


class WaveForecast(BaseModel):
    """One immutable forecast as it was known at issuance time.

    ``issued_at`` is mandatory so an evaluator cannot accidentally treat a
    retrospective analysis or a later model cycle as an issued forecast.
    """

    model_config = ConfigDict(frozen=True)

    forecast_id: str | None = None
    source_id: str
    issued_at: datetime
    valid_at: datetime
    wave_height_m: float | None = Field(default=None, ge=0)
    peak_period_s: float | None = Field(default=None, ge=0)
    direction_deg: float | None = Field(default=None, ge=0, le=360)

    @model_validator(mode="before")
    @classmethod
    def accept_normalized_forecast_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        row = dict(value)
        aliases = {
            "issued_at": ("model_cycle_at", "cycle"),
            "valid_at": ("forecast_at", "forecast_time"),
            "wave_height_m": ("offshore_height_m", "nearshore_height_m"),
            "peak_period_s": ("dominant_period_s", "period_s"),
            "direction_deg": ("primary_direction_deg", "mean_wave_direction_deg"),
        }
        for target, candidates in aliases.items():
            if target in row:
                continue
            present = [candidate for candidate in candidates if row.get(candidate) is not None]
            if target == "wave_height_m" and len(present) > 1:
                raise ValueError(
                    "both offshore_height_m and nearshore_height_m are present; "
                    "set wave_height_m explicitly to select the field under evaluation"
                )
            if present:
                row[target] = row[present[0]]
        return row

    @model_validator(mode="after")
    def validate_times(self) -> WaveForecast:
        issued_at = _utc_datetime(self.issued_at, field_name="issued_at")
        valid_at = _utc_datetime(self.valid_at, field_name="valid_at")
        if issued_at > valid_at:
            raise ValueError(
                "issued_at must be at or before valid_at; retrospective values "
                "cannot be evaluated as issued forecasts"
            )
        object.__setattr__(self, "issued_at", issued_at)
        object.__setattr__(self, "valid_at", valid_at)
        return self

    @property
    def lead_hours(self) -> float:
        return (self.valid_at - self.issued_at).total_seconds() / 3600


class WaveObservation(BaseModel):
    model_config = ConfigDict(frozen=True)

    observation_id: str | None = None
    source_id: str
    observed_at: datetime
    wave_height_m: float | None = Field(default=None, ge=0)
    peak_period_s: float | None = Field(default=None, ge=0)
    direction_deg: float | None = Field(default=None, ge=0, le=360)

    @model_validator(mode="before")
    @classmethod
    def accept_normalized_observation_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        row = dict(value)
        aliases = {
            "observed_at": ("time", "valid_at"),
            "peak_period_s": ("dominant_period_s", "period_s"),
            "direction_deg": ("primary_direction_deg", "mean_wave_direction_deg"),
        }
        for target, candidates in aliases.items():
            if target in row:
                continue
            for candidate in candidates:
                if candidate in row:
                    row[target] = row[candidate]
                    break
        return row

    @model_validator(mode="after")
    def normalize_time(self) -> WaveObservation:
        object.__setattr__(
            self,
            "observed_at",
            _utc_datetime(self.observed_at, field_name="observed_at"),
        )
        return self


class NdbcWaveObservation(BaseModel):
    model_config = ConfigDict(frozen=True)

    station_id: str
    observed_at: datetime
    wave_height_m: float | None = Field(default=None, ge=0)
    dominant_period_s: float | None = Field(default=None, ge=0)
    mean_wave_direction_deg: float | None = Field(default=None, ge=0, le=360)

    def as_wave_observation(self) -> WaveObservation:
        return WaveObservation(
            observation_id=f"{self.station_id}:{self.observed_at.isoformat()}",
            source_id=f"ndbc:{self.station_id}",
            observed_at=self.observed_at,
            wave_height_m=self.wave_height_m,
            peak_period_s=self.dominant_period_s,
            direction_deg=self.mean_wave_direction_deg,
        )


class NdbcObservationSummary(BaseModel):
    """Descriptive observation statistics; deliberately not a backtest."""

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
    circular_mean_direction_deg: float | None


class EvaluationConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    match_tolerance_minutes: float = Field(default=30.0, gt=0)
    allow_future_observations: bool = False
    wave_height_tolerance_m: float = Field(default=0.5, gt=0)
    peak_period_tolerance_s: float = Field(default=2.0, gt=0)
    direction_tolerance_deg: float = Field(default=22.5, gt=0, le=180)


class FieldMetrics(BaseModel):
    model_config = ConfigDict(frozen=True)

    error_kind: Literal["linear", "circular_degrees"]
    tolerance: float
    eligible_forecast_count: int
    matched_count: int
    coverage: float | None
    mae: float | None
    rmse: float | None
    bias: float | None
    median_absolute_error: float | None
    within_tolerance_count: int
    within_tolerance_rate: float | None


class EvaluationMetrics(BaseModel):
    model_config = ConfigDict(frozen=True)

    forecast_count: int
    time_matched_count: int
    time_match_coverage: float | None
    wave_height: FieldMetrics
    peak_period: FieldMetrics
    direction: FieldMetrics


class EvaluationSample(BaseModel):
    model_config = ConfigDict(frozen=True)

    forecast_id: str
    forecast_source_id: str
    issued_at: datetime
    valid_at: datetime
    lead_hours: float
    lead_bucket: str
    observation_id: str | None
    observation_source_id: str | None
    observed_at: datetime | None
    observation_lag_minutes: float | None
    wave_height_forecast_m: float | None
    wave_height_observed_m: float | None
    wave_height_error_m: float | None
    peak_period_forecast_s: float | None
    peak_period_observed_s: float | None
    peak_period_error_s: float | None
    direction_forecast_deg: float | None
    direction_observed_deg: float | None
    direction_error_deg: float | None


class LeadBucketMetrics(BaseModel):
    model_config = ConfigDict(frozen=True)

    bucket: str
    minimum_lead_hours: float
    maximum_lead_hours: float | None
    metrics: EvaluationMetrics


class PhysicalEvaluationReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: str = EVALUATION_SCHEMA_VERSION
    config: EvaluationConfig
    metrics: EvaluationMetrics
    lead_buckets: tuple[LeadBucketMetrics, ...]
    samples: tuple[EvaluationSample, ...]
    context: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


LEAD_BUCKETS: tuple[tuple[str, float, float | None], ...] = (
    ("0-12h", 0, 12),
    ("12-24h", 12, 24),
    ("24-48h", 24, 48),
    ("48-72h", 48, 72),
    ("72-120h", 72, 120),
    ("120h+", 120, None),
)


def ndbc_history_url(station_id: str, year: int) -> str:
    return f"{NDBC_HISTORY_URL}/{station_id}h{year}.txt.gz"


def _number_or_none(value: str, *, missing: set[float]) -> float | None:
    try:
        parsed = float(value)
    except ValueError:
        return None
    if not math.isfinite(parsed) or parsed in missing:
        return None
    return parsed


def _find_header(text: str) -> tuple[str, ...]:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("#"):
            continue
        columns = stripped.lstrip("#").split()
        upper = {column.upper() for column in columns}
        if {"MM", "DD", "HH", "WVHT"}.issubset(upper) and (
            "YY" in upper or "YYYY" in upper
        ):
            return tuple(columns)
    raise NdbcParseError(
        "NDBC history did not contain a standard-meteorological column header"
    )


def _column_index(columns: Sequence[str], *names: str) -> int | None:
    declared = [column.lstrip("#") for column in columns]
    for name in names:
        try:
            return declared.index(name)
        except ValueError:
            continue
    # NDBC deliberately uses MM for month and mm for minute, so a
    # case-insensitive fallback would silently turn the month into minutes.
    if "mm" in names:
        return None
    normalized = [column.upper() for column in declared]
    for name in names:
        try:
            return normalized.index(name.upper())
        except ValueError:
            continue
    return None


def parse_ndbc_standard_met_history(
    station_id: str,
    text: str,
) -> tuple[NdbcWaveObservation, ...]:
    """Parse NDBC annual stdmet text by its declared header, not positions."""

    columns = _find_header(text)
    year_index = _column_index(columns, "YY", "YYYY")
    month_index = _column_index(columns, "MM")
    day_index = _column_index(columns, "DD")
    hour_index = _column_index(columns, "hh")
    minute_index = _column_index(columns, "mm")
    height_index = _column_index(columns, "WVHT")
    period_index = _column_index(columns, "DPD")
    direction_index = _column_index(columns, "MWD")

    required = {
        "year": year_index,
        "month": month_index,
        "day": day_index,
        "hour": hour_index,
        "WVHT": height_index,
    }
    missing_columns = [name for name, position in required.items() if position is None]
    if missing_columns:
        raise NdbcParseError(
            f"NDBC history header is missing required columns: {', '.join(missing_columns)}"
        )

    # This assertion narrows Optional[int] after the explicit schema check.
    assert year_index is not None
    assert month_index is not None
    assert day_index is not None
    assert hour_index is not None
    assert height_index is not None
    max_index = max(
        position
        for position in (
            year_index,
            month_index,
            day_index,
            hour_index,
            minute_index,
            height_index,
            period_index,
            direction_index,
        )
        if position is not None
    )

    observations: list[NdbcWaveObservation] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) <= max_index:
            continue
        try:
            raw_year = int(parts[year_index])
            year = raw_year + (2000 if raw_year < 70 else 1900) if raw_year < 100 else raw_year
            minute = int(parts[minute_index]) if minute_index is not None else 0
            observed_at = datetime(
                year,
                int(parts[month_index]),
                int(parts[day_index]),
                int(parts[hour_index]),
                minute,
                tzinfo=timezone.utc,
            )
        except (ValueError, IndexError):
            continue

        wave_height = _number_or_none(parts[height_index], missing={99.0, 999.0, 9999.0})
        dominant_period = (
            _number_or_none(parts[period_index], missing={99.0, 999.0, 9999.0})
            if period_index is not None
            else None
        )
        direction = (
            _number_or_none(parts[direction_index], missing={999.0, 9999.0})
            if direction_index is not None
            else None
        )
        if direction is not None and not 0 <= direction <= 360:
            direction = None
        observations.append(
            NdbcWaveObservation(
                station_id=station_id,
                observed_at=observed_at,
                wave_height_m=wave_height,
                dominant_period_s=dominant_period,
                mean_wave_direction_deg=direction,
            )
        )

    if not observations:
        raise NdbcParseError(f"No NDBC observations parsed for {station_id}")
    return tuple(observations)


def circular_mean_degrees(values: Iterable[float]) -> float | None:
    angles = tuple(values)
    if not angles:
        return None
    sine = mean(math.sin(math.radians(value)) for value in angles)
    cosine = mean(math.cos(math.radians(value)) for value in angles)
    if math.hypot(sine, cosine) < 1e-12:
        return None
    result = math.degrees(math.atan2(sine, cosine)) % 360
    return 0.0 if math.isclose(result, 360, abs_tol=1e-12) else result


def circular_difference_degrees(forecast: float, observed: float) -> float:
    """Shortest signed forecast-minus-observation angle in [-180, 180)."""

    return (forecast - observed + 180) % 360 - 180


def summarize_ndbc_wave_history(
    station_id: str,
    observations: tuple[NdbcWaveObservation, ...],
) -> NdbcObservationSummary:
    if not observations:
        raise ValueError(f"No NDBC observations parsed for {station_id}")

    wave_heights = [row.wave_height_m for row in observations if row.wave_height_m is not None]
    periods = [
        row.dominant_period_s
        for row in observations
        if row.dominant_period_s is not None
    ]
    directions = [
        row.mean_wave_direction_deg
        for row in observations
        if row.mean_wave_direction_deg is not None
    ]
    circular_direction = circular_mean_degrees(directions)

    return NdbcObservationSummary(
        station_id=station_id,
        started_at=min(row.observed_at for row in observations),
        ended_at=max(row.observed_at for row in observations),
        sample_count=len(observations),
        wave_height_sample_count=len(wave_heights),
        dominant_period_sample_count=len(periods),
        direction_sample_count=len(directions),
        mean_wave_height_m=round(mean(wave_heights), 3) if wave_heights else None,
        mean_dominant_period_s=round(mean(periods), 3) if periods else None,
        circular_mean_direction_deg=(
            round(circular_direction, 1) if circular_direction is not None else None
        ),
    )


def fetch_ndbc_standard_met_history(
    station_id: str,
    year: int,
    *,
    client: httpx.Client | None = None,
) -> str:
    url = ndbc_history_url(station_id, year)
    owns_client = client is None
    active_client = client or httpx.Client(timeout=30.0, follow_redirects=True)
    try:
        try:
            response = active_client.get(url)
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise NdbcArchiveUnavailable(
                station_id=station_id,
                year=year,
                url=url,
                status_code=error.response.status_code,
            ) from error
        except httpx.RequestError as error:
            raise NdbcArchiveUnavailable(
                station_id=station_id,
                year=year,
                url=url,
                detail=str(error),
            ) from error
        try:
            return gzip.decompress(response.content).decode("utf-8", errors="replace")
        except (gzip.BadGzipFile, EOFError, OSError) as error:
            raise NdbcArchiveInvalid(
                f"NDBC archive for {station_id} in {year} was not valid gzip data: {url}"
            ) from error
    finally:
        if owns_client:
            active_client.close()


def run_ndbc_history_summary(station_id: str, year: int) -> NdbcObservationSummary:
    text = fetch_ndbc_standard_met_history(station_id, year)
    return summarize_ndbc_wave_history(
        station_id,
        parse_ndbc_standard_met_history(station_id, text),
    )


def lead_bucket(lead_hours: float) -> tuple[str, float, float | None]:
    for bucket, minimum, maximum in LEAD_BUCKETS:
        if lead_hours >= minimum and (maximum is None or lead_hours < maximum):
            return bucket, minimum, maximum
    raise ValueError(f"Negative forecast lead is invalid: {lead_hours}")


def _nearest_observation(
    valid_at: datetime,
    observations: Sequence[WaveObservation],
    observation_times: Sequence[datetime],
    config: EvaluationConfig,
) -> WaveObservation | None:
    if not observations:
        return None
    insertion = bisect_right(observation_times, valid_at)
    candidate_indices: list[int] = []
    if insertion > 0:
        candidate_indices.append(insertion - 1)
    if config.allow_future_observations and insertion < len(observations):
        candidate_indices.append(insertion)
    if not candidate_indices:
        return None

    # On equal distance, prefer the earlier observation for deterministic
    # no-lookahead behavior.
    best_index = min(
        candidate_indices,
        key=lambda position: (
            abs((observations[position].observed_at - valid_at).total_seconds()),
            observations[position].observed_at > valid_at,
            observations[position].observed_at,
        ),
    )
    candidate = observations[best_index]
    difference = abs((candidate.observed_at - valid_at).total_seconds())
    if difference > config.match_tolerance_minutes * 60:
        return None
    return candidate


def _sample_id(forecast: WaveForecast, position: int) -> str:
    return forecast.forecast_id or (
        f"{forecast.source_id}:{forecast.issued_at.isoformat()}:"
        f"{forecast.valid_at.isoformat()}:{position}"
    )


def match_forecasts_to_observations(
    forecasts: Sequence[WaveForecast],
    observations: Sequence[WaveObservation],
    config: EvaluationConfig,
) -> tuple[EvaluationSample, ...]:
    ordered_forecasts = sorted(
        forecasts,
        key=lambda row: (row.valid_at, row.issued_at, row.source_id, row.forecast_id or ""),
    )
    ordered_observations = sorted(
        observations,
        key=lambda row: (row.observed_at, row.source_id, row.observation_id or ""),
    )
    observation_times = [row.observed_at for row in ordered_observations]

    samples: list[EvaluationSample] = []
    for position, forecast in enumerate(ordered_forecasts):
        observation = _nearest_observation(
            forecast.valid_at,
            ordered_observations,
            observation_times,
            config,
        )
        bucket, _, _ = lead_bucket(forecast.lead_hours)
        height_error = (
            forecast.wave_height_m - observation.wave_height_m
            if observation is not None
            and forecast.wave_height_m is not None
            and observation.wave_height_m is not None
            else None
        )
        period_error = (
            forecast.peak_period_s - observation.peak_period_s
            if observation is not None
            and forecast.peak_period_s is not None
            and observation.peak_period_s is not None
            else None
        )
        direction_error = (
            circular_difference_degrees(forecast.direction_deg, observation.direction_deg)
            if observation is not None
            and forecast.direction_deg is not None
            and observation.direction_deg is not None
            else None
        )
        samples.append(
            EvaluationSample(
                forecast_id=_sample_id(forecast, position),
                forecast_source_id=forecast.source_id,
                issued_at=forecast.issued_at,
                valid_at=forecast.valid_at,
                lead_hours=round(forecast.lead_hours, 6),
                lead_bucket=bucket,
                observation_id=observation.observation_id if observation else None,
                observation_source_id=observation.source_id if observation else None,
                observed_at=observation.observed_at if observation else None,
                observation_lag_minutes=(
                    round(
                        (observation.observed_at - forecast.valid_at).total_seconds() / 60,
                        6,
                    )
                    if observation
                    else None
                ),
                wave_height_forecast_m=forecast.wave_height_m,
                wave_height_observed_m=observation.wave_height_m if observation else None,
                wave_height_error_m=height_error,
                peak_period_forecast_s=forecast.peak_period_s,
                peak_period_observed_s=observation.peak_period_s if observation else None,
                peak_period_error_s=period_error,
                direction_forecast_deg=forecast.direction_deg,
                direction_observed_deg=observation.direction_deg if observation else None,
                direction_error_deg=direction_error,
            )
        )
    return tuple(samples)


def _rounded(value: float) -> float:
    return round(value, 6)


def _field_metrics(
    *,
    forecast_values: Sequence[float | None],
    errors: Sequence[float | None],
    tolerance: float,
    circular: bool,
) -> FieldMetrics:
    eligible_count = sum(value is not None for value in forecast_values)
    values = [value for value in errors if value is not None]
    absolute = [abs(value) for value in values]
    bias = circular_mean_degrees(values) if circular and values else None
    if bias is not None and bias > 180:
        bias -= 360
    if not circular and values:
        bias = mean(values)
    within_count = sum(value <= tolerance for value in absolute)
    return FieldMetrics(
        error_kind="circular_degrees" if circular else "linear",
        tolerance=tolerance,
        eligible_forecast_count=eligible_count,
        matched_count=len(values),
        coverage=(
            _rounded(len(values) / eligible_count) if eligible_count else None
        ),
        mae=_rounded(mean(absolute)) if absolute else None,
        rmse=(
            _rounded(math.sqrt(mean(value * value for value in values)))
            if values
            else None
        ),
        bias=_rounded(bias) if bias is not None else None,
        median_absolute_error=_rounded(median(absolute)) if absolute else None,
        within_tolerance_count=within_count,
        within_tolerance_rate=(
            _rounded(within_count / len(values)) if values else None
        ),
    )


def summarize_evaluation_samples(
    samples: Sequence[EvaluationSample],
    config: EvaluationConfig,
) -> EvaluationMetrics:
    time_matched = sum(sample.observed_at is not None for sample in samples)
    return EvaluationMetrics(
        forecast_count=len(samples),
        time_matched_count=time_matched,
        time_match_coverage=(
            _rounded(time_matched / len(samples)) if samples else None
        ),
        wave_height=_field_metrics(
            forecast_values=[sample.wave_height_forecast_m for sample in samples],
            errors=[sample.wave_height_error_m for sample in samples],
            tolerance=config.wave_height_tolerance_m,
            circular=False,
        ),
        peak_period=_field_metrics(
            forecast_values=[sample.peak_period_forecast_s for sample in samples],
            errors=[sample.peak_period_error_s for sample in samples],
            tolerance=config.peak_period_tolerance_s,
            circular=False,
        ),
        direction=_field_metrics(
            forecast_values=[sample.direction_forecast_deg for sample in samples],
            errors=[sample.direction_error_deg for sample in samples],
            tolerance=config.direction_tolerance_deg,
            circular=True,
        ),
    )


def evaluate_physical_forecasts(
    forecasts: Sequence[WaveForecast],
    observations: Sequence[WaveObservation],
    *,
    config: EvaluationConfig | None = None,
    context: dict[str, str | int | float | bool | None] | None = None,
) -> PhysicalEvaluationReport:
    active_config = config or EvaluationConfig()
    samples = match_forecasts_to_observations(
        forecasts,
        observations,
        active_config,
    )
    bucket_metrics: list[LeadBucketMetrics] = []
    for bucket, minimum, maximum in LEAD_BUCKETS:
        bucket_samples = [sample for sample in samples if sample.lead_bucket == bucket]
        bucket_metrics.append(
            LeadBucketMetrics(
                bucket=bucket,
                minimum_lead_hours=minimum,
                maximum_lead_hours=maximum,
                metrics=summarize_evaluation_samples(bucket_samples, active_config),
            )
        )
    return PhysicalEvaluationReport(
        config=active_config,
        metrics=summarize_evaluation_samples(samples, active_config),
        lead_buckets=tuple(bucket_metrics),
        samples=samples,
        context=context or {},
    )


def load_jsonl(path: Path, model: type[BaseModel]) -> tuple[BaseModel, ...]:
    rows: list[BaseModel] = []
    for line_number, line in enumerate(path.read_text().splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            rows.append(model.model_validate_json(stripped))
        except (ValueError, json.JSONDecodeError) as error:
            raise ValueError(
                f"Invalid {model.__name__} at {path}:{line_number}: {error}"
            ) from error
    return tuple(rows)


def write_evaluation_artifacts(
    report: PhysicalEvaluationReport,
    *,
    json_path: Path | None = None,
    samples_jsonl_path: Path | None = None,
) -> str:
    """Serialize stable, sorted JSON and optional one-sample-per-line JSONL."""

    document = json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True)
    if json_path is not None:
        json_path.write_text(f"{document}\n")
    if samples_jsonl_path is not None:
        lines = [
            json.dumps(sample.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
            for sample in report.samples
        ]
        samples_jsonl_path.write_text("\n".join(lines) + ("\n" if lines else ""))
    return document
