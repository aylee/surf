from __future__ import annotations

import math
import re
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from .backtest import (
    EvaluationConfig,
    PhysicalEvaluationReport,
    WaveForecast,
    WaveObservation,
    evaluate_physical_forecasts,
)


CDIP_OPENDAP_ROOT = "https://thredds.cdip.ucsd.edu/thredds/dodsC/"
CDIP_REQUIRED_MOP_VARIABLES = ("waveTime", "waveHs")
CDIP_OPTIONAL_MOP_VARIABLES = ("waveTp", "waveDp")


class CdipError(RuntimeError):
    """Base error for public CDIP OPeNDAP access."""


class CdipDatasetUnavailable(CdipError):
    """Raised when a configured CDIP dataset cannot be retrieved."""


class CdipDatasetInvalid(CdipError):
    """Raised when a CDIP response is missing required schema or values."""


class CdipMopMapping(BaseModel):
    """Explicit operator-supplied link from a spot to a CDIP MOP point.

    MOP values are a modeled nearshore reference, not observed breaking-wave
    truth. Keeping mappings explicit prevents a geographically-near point from
    being silently treated as the correct surf break.
    """

    model_config = ConfigDict(frozen=True)

    spot_id: str
    cdip_point_id: str
    dataset_url: HttpUrl
    height_scale: float = Field(..., gt=0, le=5)
    reference_kind: Literal["modeled_nearshore_proxy"] = "modeled_nearshore_proxy"


class CdipMopMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)

    cdip_point_id: str
    dataset_url: str
    variables: tuple[str, ...]
    wave_time_count: int = Field(..., ge=1)
    latitude: float | None = None
    longitude: float | None = None
    time_coverage_start: datetime | None = None
    time_coverage_end: datetime | None = None
    date_issued: datetime | None = None
    license: str | None = None


class CdipMopValue(BaseModel):
    model_config = ConfigDict(frozen=True)

    cdip_point_id: str
    observed_at: datetime
    wave_height_m: float | None = Field(default=None, ge=0)
    peak_period_s: float | None = Field(default=None, ge=0)
    direction_deg: float | None = Field(default=None, ge=0, le=360)

    def as_wave_observation(self) -> WaveObservation:
        return WaveObservation(
            observation_id=f"{self.cdip_point_id}:{self.observed_at.isoformat()}",
            source_id=f"cdip-mop:{self.cdip_point_id}",
            observed_at=self.observed_at,
            wave_height_m=self.wave_height_m,
            peak_period_s=self.peak_period_s,
            direction_deg=self.direction_deg,
        )


def normalize_cdip_dataset_url(dataset_url: str | HttpUrl) -> str:
    url = str(dataset_url)
    for suffix in (".html", ".ascii", ".dds", ".das"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url


def build_cdip_opendap_ascii_url(
    dataset_url: str | HttpUrl,
    *,
    start_index: int,
    stop_index: int,
    stride: int = 1,
    variables: Sequence[str] = (
        *CDIP_REQUIRED_MOP_VARIABLES,
        *CDIP_OPTIONAL_MOP_VARIABLES,
    ),
) -> str:
    if start_index < 0:
        raise ValueError("start_index must be non-negative")
    if stop_index < start_index:
        raise ValueError("stop_index must be at or after start_index")
    if stride <= 0:
        raise ValueError("stride must be positive")
    unsupported = [
        variable
        for variable in variables
        if variable not in (*CDIP_REQUIRED_MOP_VARIABLES, *CDIP_OPTIONAL_MOP_VARIABLES)
    ]
    if unsupported:
        raise ValueError(f"Unsupported CDIP MOP variables: {', '.join(unsupported)}")
    constraint = ",".join(
        f"{variable}[{start_index}:{stride}:{stop_index}]" for variable in variables
    )
    return f"{normalize_cdip_dataset_url(dataset_url)}.ascii?{constraint}"


def _fetch_text(client: httpx.Client, url: str) -> str:
    try:
        response = client.get(url)
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        raise CdipDatasetUnavailable(
            f"CDIP dataset request failed with HTTP {error.response.status_code}: {url}"
        ) from error
    except httpx.RequestError as error:
        raise CdipDatasetUnavailable(f"CDIP dataset request failed: {url}: {error}") from error
    return response.text


def _parse_dds_variables(text: str) -> tuple[str, ...]:
    variables = re.findall(
        r"^\s*(?:Byte|Int16|UInt16|Int32|UInt32|Float32|Float64|String)\s+"
        r"([A-Za-z][A-Za-z0-9_]*)\b",
        text,
        flags=re.MULTILINE,
    )
    return tuple(dict.fromkeys(variables))


def _das_string(text: str, attribute: str) -> str | None:
    pattern = rf"\b{re.escape(attribute)}\s+\"((?:[^\"\\]|\\.)*)\"\s*;"
    match = re.search(pattern, text)
    return bytes(match.group(1), "utf-8").decode("unicode_escape") if match else None


def _das_number(text: str, attribute: str) -> float | None:
    pattern = rf"\b{re.escape(attribute)}\s+([-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?)\s*;"
    match = re.search(pattern, text)
    return float(match.group(1)) if match else None


def _iso_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise CdipDatasetInvalid(f"CDIP timestamp did not include a UTC offset: {value}")
    return parsed.astimezone(timezone.utc)


def parse_cdip_mop_metadata(
    *,
    cdip_point_id: str,
    dataset_url: str | HttpUrl,
    dds_text: str,
    das_text: str,
) -> CdipMopMetadata:
    variables = _parse_dds_variables(dds_text)
    missing = [variable for variable in CDIP_REQUIRED_MOP_VARIABLES if variable not in variables]
    if missing:
        raise CdipDatasetInvalid(
            f"CDIP MOP dataset is missing required variables: {', '.join(missing)}"
        )
    count_match = re.search(r"\bwaveTime\s*\[\s*waveTime\s*=\s*(\d+)\s*\]", dds_text)
    if count_match is None or int(count_match.group(1)) < 1:
        raise CdipDatasetInvalid("CDIP MOP dataset has no bounded waveTime dimension")
    return CdipMopMetadata(
        cdip_point_id=cdip_point_id,
        dataset_url=normalize_cdip_dataset_url(dataset_url),
        variables=variables,
        wave_time_count=int(count_match.group(1)),
        latitude=_das_number(das_text, "geospatial_lat_min"),
        longitude=_das_number(das_text, "geospatial_lon_min"),
        time_coverage_start=_iso_datetime(_das_string(das_text, "time_coverage_start")),
        time_coverage_end=_iso_datetime(_das_string(das_text, "time_coverage_end")),
        date_issued=_iso_datetime(_das_string(das_text, "date_issued")),
        license=_das_string(das_text, "license"),
    )


def fetch_cdip_mop_metadata(
    mapping: CdipMopMapping,
    *,
    client: httpx.Client | None = None,
) -> CdipMopMetadata:
    base_url = normalize_cdip_dataset_url(mapping.dataset_url)
    owns_client = client is None
    active_client = client or httpx.Client(timeout=30.0, follow_redirects=True)
    try:
        return parse_cdip_mop_metadata(
            cdip_point_id=mapping.cdip_point_id,
            dataset_url=base_url,
            dds_text=_fetch_text(active_client, f"{base_url}.dds"),
            das_text=_fetch_text(active_client, f"{base_url}.das"),
        )
    finally:
        if owns_client:
            active_client.close()


def parse_cdip_opendap_ascii(
    text: str,
    *,
    required_variables: Sequence[str] = CDIP_REQUIRED_MOP_VARIABLES,
) -> dict[str, tuple[float, ...]]:
    if "---------------------------------------------" not in text:
        raise CdipDatasetInvalid("CDIP OPeNDAP ASCII response had no data section")
    data = text.split("---------------------------------------------", maxsplit=1)[1]
    sections: dict[str, list[float]] = {}
    current: str | None = None
    for raw_line in data.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        header = re.fullmatch(r"([A-Za-z][A-Za-z0-9_]*)\[\d+\]", line)
        if header:
            current = header.group(1)
            sections.setdefault(current, [])
            continue
        if current is None:
            continue
        for value in line.split(","):
            stripped = value.strip()
            if not stripped:
                continue
            try:
                sections[current].append(float(stripped))
            except ValueError as error:
                raise CdipDatasetInvalid(
                    f"Invalid {current} value in CDIP OPeNDAP ASCII response: {stripped}"
                ) from error
    missing = [variable for variable in required_variables if variable not in sections]
    if missing:
        raise CdipDatasetInvalid(
            f"CDIP OPeNDAP response omitted variables: {', '.join(missing)}"
        )
    return {name: tuple(values) for name, values in sections.items()}


def _valid_wave_value(value: float, *, maximum: float) -> float | None:
    if not math.isfinite(value) or value <= -999 or value < 0 or value > maximum:
        return None
    return value


def cdip_mop_values_from_ascii(
    cdip_point_id: str,
    text: str,
) -> tuple[CdipMopValue, ...]:
    arrays = parse_cdip_opendap_ascii(text)
    times = arrays["waveTime"]
    heights = arrays["waveHs"]
    periods = arrays.get("waveTp")
    directions = arrays.get("waveDp")
    lengths = {len(times), len(heights)}
    if periods is not None:
        lengths.add(len(periods))
    if directions is not None:
        lengths.add(len(directions))
    if len(lengths) != 1:
        raise CdipDatasetInvalid("CDIP OPeNDAP variables had inconsistent lengths")

    rows: list[CdipMopValue] = []
    for index, epoch in enumerate(times):
        try:
            observed_at = datetime.fromtimestamp(epoch, tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as error:
            raise CdipDatasetInvalid(f"Invalid CDIP waveTime epoch: {epoch}") from error
        direction = (
            _valid_wave_value(directions[index], maximum=360)
            if directions is not None
            else None
        )
        rows.append(
            CdipMopValue(
                cdip_point_id=cdip_point_id,
                observed_at=observed_at,
                wave_height_m=_valid_wave_value(heights[index], maximum=20),
                peak_period_s=(
                    _valid_wave_value(periods[index], maximum=40)
                    if periods is not None
                    else None
                ),
                direction_deg=direction,
            )
        )
    return tuple(rows)


def fetch_cdip_mop_series(
    mapping: CdipMopMapping,
    *,
    start_index: int,
    stop_index: int,
    stride: int = 1,
    variables: Sequence[str] = (
        *CDIP_REQUIRED_MOP_VARIABLES,
        *CDIP_OPTIONAL_MOP_VARIABLES,
    ),
    client: httpx.Client | None = None,
) -> tuple[CdipMopValue, ...]:
    url = build_cdip_opendap_ascii_url(
        mapping.dataset_url,
        start_index=start_index,
        stop_index=stop_index,
        stride=stride,
        variables=variables,
    )
    owns_client = client is None
    active_client = client or httpx.Client(timeout=30.0, follow_redirects=True)
    try:
        return cdip_mop_values_from_ascii(
            mapping.cdip_point_id,
            _fetch_text(active_client, url),
        )
    finally:
        if owns_client:
            active_client.close()


def fetch_cdip_mop_time_window(
    mapping: CdipMopMapping,
    metadata: CdipMopMetadata,
    *,
    started_at: datetime,
    ended_at: datetime,
    padding: timedelta = timedelta(minutes=30),
    max_records: int = 50_000,
    client: httpx.Client | None = None,
) -> tuple[CdipMopValue, ...]:
    """Fetch the bounded MOP slice overlapping an explicit UTC interval."""

    if started_at.tzinfo is None or started_at.utcoffset() is None:
        raise ValueError("started_at must include a UTC offset")
    if ended_at.tzinfo is None or ended_at.utcoffset() is None:
        raise ValueError("ended_at must include a UTC offset")
    started_at = started_at.astimezone(timezone.utc)
    ended_at = ended_at.astimezone(timezone.utc)
    if ended_at < started_at:
        raise ValueError("ended_at must be at or after started_at")
    if metadata.cdip_point_id != mapping.cdip_point_id:
        raise ValueError("CDIP metadata point does not match the supplied mapping")
    if metadata.wave_time_count > max_records:
        raise CdipDatasetInvalid(
            f"CDIP waveTime has {metadata.wave_time_count} records, above the "
            f"explicit max_records={max_records} guard"
        )

    time_url = build_cdip_opendap_ascii_url(
        mapping.dataset_url,
        start_index=0,
        stop_index=metadata.wave_time_count - 1,
        variables=("waveTime",),
    )
    owns_client = client is None
    active_client = client or httpx.Client(timeout=30.0, follow_redirects=True)
    try:
        arrays = parse_cdip_opendap_ascii(
            _fetch_text(active_client, time_url),
            required_variables=("waveTime",),
        )
        epochs = arrays["waveTime"]
        if len(epochs) != metadata.wave_time_count:
            raise CdipDatasetInvalid(
                "CDIP waveTime response length did not match dataset metadata"
            )
        lower = (started_at - padding).timestamp()
        upper = (ended_at + padding).timestamp()
        start_index = bisect_left(epochs, lower)
        stop_index = bisect_right(epochs, upper) - 1
        if start_index >= len(epochs) or stop_index < start_index:
            raise CdipDatasetInvalid(
                "CDIP MOP dataset does not overlap the requested forecast interval"
            )
        return fetch_cdip_mop_series(
            mapping,
            start_index=start_index,
            stop_index=stop_index,
            client=active_client,
        )
    finally:
        if owns_client:
            active_client.close()


def apply_fixed_height_transform(
    forecasts: Sequence[WaveForecast],
    mapping: CdipMopMapping,
) -> tuple[WaveForecast, ...]:
    return tuple(
        WaveForecast(
            forecast_id=forecast.forecast_id,
            source_id=f"{forecast.source_id}:height-scale-{mapping.height_scale:g}",
            issued_at=forecast.issued_at,
            valid_at=forecast.valid_at,
            wave_height_m=(
                forecast.wave_height_m * mapping.height_scale
                if forecast.wave_height_m is not None
                else None
            ),
            peak_period_s=forecast.peak_period_s,
            direction_deg=forecast.direction_deg,
        )
        for forecast in forecasts
    )


def evaluate_fixed_transform_against_cdip(
    forecasts: Sequence[WaveForecast],
    cdip_values: Sequence[CdipMopValue],
    mapping: CdipMopMapping,
    *,
    config: EvaluationConfig | None = None,
    metadata: CdipMopMetadata | None = None,
) -> PhysicalEvaluationReport:
    context: dict[str, str | int | float | bool | None] = {
        "spot_id": mapping.spot_id,
        "cdip_point_id": mapping.cdip_point_id,
        "cdip_dataset_url": normalize_cdip_dataset_url(mapping.dataset_url),
        "height_scale": mapping.height_scale,
        "reference_kind": mapping.reference_kind,
        "reference_is_breaking_wave_truth": False,
    }
    if metadata is not None:
        context.update(
            {
                "cdip_latitude": metadata.latitude,
                "cdip_longitude": metadata.longitude,
                "cdip_date_issued": (
                    metadata.date_issued.isoformat() if metadata.date_issued else None
                ),
            }
        )
    return evaluate_physical_forecasts(
        apply_fixed_height_transform(forecasts, mapping),
        [value.as_wave_observation() for value in cdip_values],
        config=config,
        context=context,
    )
