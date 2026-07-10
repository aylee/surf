from __future__ import annotations

import hashlib
import itertools
import json
import math
import re
import tempfile
import xml.etree.ElementTree as ElementTree
from collections.abc import Sequence
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Protocol
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

from .backtest import EvaluationConfig, PhysicalEvaluationReport, WaveForecast
from .cdip import (
    CdipMopMapping,
    CdipMopMetadata,
    CdipMopValue,
    evaluate_fixed_transform_against_cdip,
    normalize_cdip_dataset_url,
)


NDFD_S3_ROOT = "https://noaa-ndfd-pds.s3.amazonaws.com"
NDFD_WMO_CODES: tuple[Literal["YKUZ98_KWBN", "YKUZ97_KWBN"], ...] = (
    "YKUZ98_KWBN",
    "YKUZ97_KWBN",
)
NDFD_HISTORY_SCHEMA_VERSION = "surf-ndfd-mop-history/v1"
MAX_ISSUE_SNAPSHOTS = 100


class NdfdHistoryError(RuntimeError):
    """Base error for bounded archived NDFD evaluation."""


class NdfdArchiveUnavailable(NdfdHistoryError):
    """Raised when a requested public S3 object/listing is unavailable."""


class NdfdArchiveSelectionError(NdfdHistoryError):
    """Raised when no no-lookahead WMO object can satisfy a snapshot."""


class NdfdGribToolingUnavailable(NdfdHistoryError):
    """Raised when the optional GRIB stack is not installed."""


class NdfdGribExtractionError(NdfdHistoryError):
    """Raised when a WMO/GRIB object cannot yield a safe point series."""


def _utc(value: datetime, *, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must include a UTC offset")
    return value.astimezone(timezone.utc)


class NdfdMopHistoryMapping(BaseModel):
    model_config = ConfigDict(frozen=True)

    spot_id: str
    target_latitude: float = Field(..., ge=-90, le=90)
    target_longitude: float = Field(..., ge=-180, le=180)
    cdip_point_id: str
    cdip_nowcast_url: HttpUrl
    current_height_scale: float = Field(..., gt=0, le=5)
    max_grid_distance_km: float = Field(..., gt=0, le=100)

    @model_validator(mode="after")
    def require_nowcast_reference(self) -> NdfdMopHistoryMapping:
        url = normalize_cdip_dataset_url(self.cdip_nowcast_url)
        if not url.endswith("_nowcast.nc"):
            raise ValueError(
                "cdip_nowcast_url must identify an explicit *_nowcast.nc dataset"
            )
        return self

    def cdip_mapping(self) -> CdipMopMapping:
        return CdipMopMapping(
            spot_id=self.spot_id,
            cdip_point_id=self.cdip_point_id,
            dataset_url=self.cdip_nowcast_url,
            height_scale=self.current_height_scale,
        )


class NdfdArchiveObject(BaseModel):
    model_config = ConfigDict(frozen=True)

    key: str
    wmo_code: Literal["YKUZ98_KWBN", "YKUZ97_KWBN"]
    wmo_issue_at: datetime
    last_modified: datetime
    etag: str
    size_bytes: int = Field(..., gt=0)

    @model_validator(mode="after")
    def normalize_times(self) -> NdfdArchiveObject:
        object.__setattr__(
            self,
            "wmo_issue_at",
            _utc(self.wmo_issue_at, field_name="wmo_issue_at"),
        )
        object.__setattr__(
            self,
            "last_modified",
            _utc(self.last_modified, field_name="last_modified"),
        )
        return self


class NdfdArchiveSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True)

    requested_as_of: datetime
    objects: tuple[NdfdArchiveObject, ...]

    @model_validator(mode="after")
    def validate_snapshot(self) -> NdfdArchiveSnapshot:
        requested = _utc(self.requested_as_of, field_name="requested_as_of")
        codes = {row.wmo_code for row in self.objects}
        if codes != set(NDFD_WMO_CODES) or len(self.objects) != len(NDFD_WMO_CODES):
            raise ValueError("snapshot must contain exactly one object for each NDFD WMO code")
        for row in self.objects:
            if row.wmo_issue_at > requested or row.last_modified > requested:
                raise ValueError("snapshot contains an object unavailable at requested_as_of")
        object.__setattr__(self, "requested_as_of", requested)
        object.__setattr__(
            self,
            "objects",
            tuple(sorted(self.objects, key=lambda row: row.wmo_code)),
        )
        return self


class NdfdGridCell(BaseModel):
    model_config = ConfigDict(frozen=True)

    latitude: float
    longitude: float
    wave_height_m: float = Field(..., ge=0)
    distance_km: float = Field(..., ge=0)


class NdfdPointForecast(BaseModel):
    model_config = ConfigDict(frozen=True)

    forecast_id: str
    source_key: str
    source_etag: str
    source_sha256: str
    wmo_code: Literal["YKUZ98_KWBN", "YKUZ97_KWBN"]
    issued_at: datetime
    valid_at: datetime
    lead_hours: float = Field(..., ge=0)
    raw_wave_height_m: float = Field(..., ge=0)
    grid_latitude: float
    grid_longitude: float
    grid_distance_km: float = Field(..., ge=0)

    @model_validator(mode="after")
    def validate_timing(self) -> NdfdPointForecast:
        issued = _utc(self.issued_at, field_name="issued_at")
        valid = _utc(self.valid_at, field_name="valid_at")
        if valid < issued:
            raise ValueError("NDFD valid_at cannot precede its WMO issue time")
        expected = (valid - issued).total_seconds() / 3600
        if not math.isclose(expected, self.lead_hours, abs_tol=1e-6):
            raise ValueError("lead_hours does not match issued_at and valid_at")
        object.__setattr__(self, "issued_at", issued)
        object.__setattr__(self, "valid_at", valid)
        return self

    def as_wave_forecast(self) -> WaveForecast:
        return WaveForecast(
            forecast_id=self.forecast_id,
            source_id=f"noaa-ndfd:{self.wmo_code}",
            issued_at=self.issued_at,
            valid_at=self.valid_at,
            wave_height_m=self.raw_wave_height_m,
        )


class NdfdMopHistoryReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: str = NDFD_HISTORY_SCHEMA_VERSION
    mapping: NdfdMopHistoryMapping
    train_cutoff: datetime
    snapshots: tuple[NdfdArchiveSnapshot, ...]
    point_forecasts: tuple[NdfdPointForecast, ...]
    cdip_metadata: CdipMopMetadata
    train: PhysicalEvaluationReport
    holdout: PhysicalEvaluationReport


class NdfdArchiveSource(Protocol):
    def list_day(
        self,
        day: date,
        wmo_code: Literal["YKUZ98_KWBN", "YKUZ97_KWBN"],
    ) -> tuple[NdfdArchiveObject, ...]: ...

    def download(self, item: NdfdArchiveObject, *, max_bytes: int) -> bytes: ...


class NdfdPointExtractor(Protocol):
    def extract(
        self,
        payload: bytes,
        item: NdfdArchiveObject,
        mapping: NdfdMopHistoryMapping,
    ) -> tuple[NdfdPointForecast, ...]: ...


def _xml_text(element: ElementTree.Element, child_name: str) -> str:
    for child in element:
        if child.tag.rsplit("}", 1)[-1] == child_name and child.text is not None:
            return child.text
    raise NdfdArchiveUnavailable(f"S3 listing entry omitted {child_name}")


def _wmo_object_from_listing(element: ElementTree.Element) -> NdfdArchiveObject:
    key = _xml_text(element, "Key")
    match = re.fullmatch(
        r"wmo/waveh/\d{4}/\d{2}/\d{2}/(YKUZ(?:97|98)_KWBN)_(\d{12})",
        key,
    )
    if match is None or match.group(1) not in NDFD_WMO_CODES:
        raise NdfdArchiveUnavailable(f"Unexpected NDFD WMO object key: {key}")
    return NdfdArchiveObject(
        key=key,
        wmo_code=match.group(1),
        wmo_issue_at=datetime.strptime(match.group(2), "%Y%m%d%H%M").replace(
            tzinfo=timezone.utc
        ),
        last_modified=datetime.fromisoformat(
            _xml_text(element, "LastModified").replace("Z", "+00:00")
        ),
        etag=_xml_text(element, "ETag").strip('"'),
        size_bytes=int(_xml_text(element, "Size")),
    )


def parse_ndfd_s3_listing(text: str) -> tuple[NdfdArchiveObject, ...]:
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as error:
        raise NdfdArchiveUnavailable("NDFD S3 listing was not valid XML") from error
    truncated = next(
        (
            child.text
            for child in root
            if child.tag.rsplit("}", 1)[-1] == "IsTruncated"
        ),
        "false",
    )
    if truncated == "true":
        raise NdfdArchiveUnavailable(
            "NDFD S3 listing exceeded the bounded request; refusing partial discovery"
        )
    rows = [
        _wmo_object_from_listing(child)
        for child in root
        if child.tag.rsplit("}", 1)[-1] == "Contents"
    ]
    return tuple(sorted(rows, key=lambda row: (row.wmo_issue_at, row.key)))


class NdfdS3ArchiveClient:
    def __init__(self, client: httpx.Client) -> None:
        self.client = client

    def list_day(
        self,
        day: date,
        wmo_code: Literal["YKUZ98_KWBN", "YKUZ97_KWBN"],
    ) -> tuple[NdfdArchiveObject, ...]:
        prefix = (
            f"wmo/waveh/{day:%Y/%m/%d}/{wmo_code}_{day:%Y%m%d}"
        )
        try:
            response = self.client.get(
                f"{NDFD_S3_ROOT}/",
                params={"list-type": "2", "prefix": prefix, "max-keys": "1000"},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise NdfdArchiveUnavailable(
                f"NDFD S3 listing failed with HTTP {error.response.status_code}: {prefix}"
            ) from error
        except httpx.RequestError as error:
            raise NdfdArchiveUnavailable(
                f"NDFD S3 listing request failed: {prefix}: {error}"
            ) from error
        rows = parse_ndfd_s3_listing(response.text)
        unexpected = [row.key for row in rows if row.wmo_code != wmo_code]
        if unexpected:
            raise NdfdArchiveUnavailable(
                f"NDFD S3 prefix returned unexpected WMO objects: {unexpected}"
            )
        return rows

    def download(self, item: NdfdArchiveObject, *, max_bytes: int) -> bytes:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        if item.size_bytes > max_bytes:
            raise NdfdArchiveUnavailable(
                f"NDFD object {item.key} is {item.size_bytes} bytes, above the "
                f"max_bytes={max_bytes} guard"
            )
        url = f"{NDFD_S3_ROOT}/{quote(item.key, safe='/')}"
        try:
            response = self.client.get(url)
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise NdfdArchiveUnavailable(
                f"NDFD object failed with HTTP {error.response.status_code}: {item.key}"
            ) from error
        except httpx.RequestError as error:
            raise NdfdArchiveUnavailable(
                f"NDFD object request failed: {item.key}: {error}"
            ) from error
        if len(response.content) != item.size_bytes:
            raise NdfdArchiveUnavailable(
                f"NDFD object size mismatch for {item.key}: expected "
                f"{item.size_bytes}, received {len(response.content)}"
            )
        return response.content


def validate_issue_snapshots(issue_ats: Sequence[datetime]) -> tuple[datetime, ...]:
    if not issue_ats:
        raise ValueError("at least one --issue-at is required")
    if len(issue_ats) > MAX_ISSUE_SNAPSHOTS:
        raise ValueError(
            f"issue snapshot count {len(issue_ats)} exceeds {MAX_ISSUE_SNAPSHOTS}"
        )
    normalized = tuple(_utc(value, field_name="issue_at") for value in issue_ats)
    if any(left >= right for left, right in zip(normalized, normalized[1:])):
        raise ValueError("issue_at values must be unique and strictly chronological")
    return normalized


def select_ndfd_archive_snapshots(
    issue_ats: Sequence[datetime],
    archive: NdfdArchiveSource,
    *,
    max_cycle_age: timedelta = timedelta(hours=12),
) -> tuple[NdfdArchiveSnapshot, ...]:
    requested = validate_issue_snapshots(issue_ats)
    if max_cycle_age <= timedelta(0) or max_cycle_age > timedelta(hours=24):
        raise ValueError("max_cycle_age must be greater than zero and at most 24 hours")
    cache: dict[
        tuple[date, Literal["YKUZ98_KWBN", "YKUZ97_KWBN"]],
        tuple[NdfdArchiveObject, ...],
    ] = {}
    snapshots: list[NdfdArchiveSnapshot] = []
    days_back = math.ceil(max_cycle_age.total_seconds() / 86_400)
    for as_of in requested:
        selected: list[NdfdArchiveObject] = []
        for code in NDFD_WMO_CODES:
            candidates: list[NdfdArchiveObject] = []
            for offset in range(days_back + 1):
                day = (as_of - timedelta(days=offset)).date()
                cache_key = (day, code)
                if cache_key not in cache:
                    cache[cache_key] = archive.list_day(day, code)
                candidates.extend(cache[cache_key])
            available = [
                row
                for row in candidates
                if row.wmo_issue_at <= as_of
                and row.last_modified <= as_of
                and as_of - row.wmo_issue_at <= max_cycle_age
            ]
            if not available:
                raise NdfdArchiveSelectionError(
                    f"No {code} object was available by {as_of.isoformat()} "
                    f"within max_cycle_age={max_cycle_age}"
                )
            selected.append(
                max(available, key=lambda row: (row.wmo_issue_at, row.last_modified, row.key))
            )
        snapshots.append(
            NdfdArchiveSnapshot(requested_as_of=as_of, objects=tuple(selected))
        )
    return tuple(snapshots)


def normalize_longitude(longitude: float) -> float:
    result = (longitude + 180) % 360 - 180
    return 180.0 if math.isclose(result, -180) and longitude > 0 else result


def haversine_km(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    radius_km = 6371.0088
    lat_a = math.radians(latitude_a)
    lat_b = math.radians(latitude_b)
    delta_lat = lat_b - lat_a
    delta_lon = math.radians(normalize_longitude(longitude_b - longitude_a))
    chord = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat_a) * math.cos(lat_b) * math.sin(delta_lon / 2) ** 2
    )
    return radius_km * 2 * math.asin(min(1.0, math.sqrt(chord)))


def nearest_finite_grid_cell(
    latitudes: Sequence[float],
    longitudes: Sequence[float],
    wave_heights_m: Sequence[float],
    *,
    target_latitude: float,
    target_longitude: float,
    max_distance_km: float,
) -> NdfdGridCell:
    if not (len(latitudes) == len(longitudes) == len(wave_heights_m)):
        raise NdfdGribExtractionError("grid coordinate/value arrays have different lengths")
    candidates: list[NdfdGridCell] = []
    for latitude, longitude, height in zip(latitudes, longitudes, wave_heights_m):
        if not all(math.isfinite(value) for value in (latitude, longitude, height)):
            continue
        if height < 0:
            continue
        normalized_longitude = normalize_longitude(longitude)
        candidates.append(
            NdfdGridCell(
                latitude=latitude,
                longitude=normalized_longitude,
                wave_height_m=height,
                distance_km=haversine_km(
                    target_latitude,
                    target_longitude,
                    latitude,
                    normalized_longitude,
                ),
            )
        )
    if not candidates:
        raise NdfdGribExtractionError("NDFD grid has no finite wave-height cells")
    nearest = min(
        candidates,
        key=lambda row: (row.distance_km, row.latitude, row.longitude),
    )
    if nearest.distance_km > max_distance_km:
        raise NdfdGribExtractionError(
            f"nearest finite NDFD wave-height cell is {nearest.distance_km:.3f} km "
            f"away, above max_grid_distance_km={max_distance_km}"
        )
    return nearest


def _datetime_from_array_value(value: object) -> datetime:
    if isinstance(value, datetime):
        return _utc(value, field_name="GRIB valid_time")
    try:
        import numpy as np

        epoch_ns = int(np.datetime64(value, "ns").astype("int64"))
    except (TypeError, ValueError, OverflowError) as error:
        raise NdfdGribExtractionError(f"invalid GRIB valid_time value: {value}") from error
    return datetime.fromtimestamp(epoch_ns / 1_000_000_000, tz=timezone.utc)


def _select_coordinate_value(data_array, dataset, selectors: dict[str, int]):  # type: ignore[no-untyped-def]
    coordinate = data_array.coords.get("valid_time")
    if coordinate is None:
        coordinate = dataset.coords.get("valid_time")
    if coordinate is None:
        raise NdfdGribExtractionError("GRIB dataset omitted valid_time")
    applicable = {dimension: index for dimension, index in selectors.items() if dimension in coordinate.dims}
    selected = coordinate.isel(applicable) if applicable else coordinate
    values = selected.values.reshape(-1)
    if len(values) != 1:
        raise NdfdGribExtractionError("GRIB valid_time was not scalar for a wave grid")
    return values[0]


class CfgribNdfdPointExtractor:
    """Lazy optional GRIB reader with coordinate-associated finite-cell lookup."""

    def extract(
        self,
        payload: bytes,
        item: NdfdArchiveObject,
        mapping: NdfdMopHistoryMapping,
    ) -> tuple[NdfdPointForecast, ...]:
        try:
            import cfgrib
            import numpy as np
        except ImportError as error:
            raise NdfdGribToolingUnavailable(
                "NDFD history extraction requires the optional grib dependencies: "
                "run `uv sync --project services/extractor --extra grib`"
            ) from error

        payload_sha256 = hashlib.sha256(payload).hexdigest()
        with tempfile.NamedTemporaryFile(suffix=".grib2") as temporary:
            temporary.write(payload)
            temporary.flush()
            try:
                datasets = [
                    dataset.load()
                    for dataset in cfgrib.open_datasets(
                        temporary.name,
                        backend_kwargs={"indexpath": ""},
                    )
                ]
            except Exception as error:
                raise NdfdGribExtractionError(
                    f"cfgrib could not decode {item.key}: {error}"
                ) from error

        results: list[NdfdPointForecast] = []
        for dataset in datasets:
            if "latitude" not in dataset.coords or "longitude" not in dataset.coords:
                continue
            wave_arrays = [
                data_array
                for name, data_array in dataset.data_vars.items()
                if name.lower() == "shww"
                or str(data_array.attrs.get("GRIB_shortName", "")).lower() == "shww"
            ]
            for data_array in wave_arrays:
                units = str(data_array.attrs.get("units", "")).lower()
                if units not in {"m", "metre", "meter", "metres", "meters"}:
                    raise NdfdGribExtractionError(
                        f"unexpected NDFD wave-height units for {item.key}: {units!r}"
                    )
                latitude = dataset.coords["latitude"]
                longitude = dataset.coords["longitude"]
                spatial_dimensions = tuple(latitude.dims)
                if not spatial_dimensions or tuple(longitude.dims) != spatial_dimensions:
                    raise NdfdGribExtractionError(
                        "GRIB latitude/longitude coordinates do not share a spatial grid"
                    )
                extra_dimensions = [
                    dimension
                    for dimension in data_array.dims
                    if dimension not in spatial_dimensions
                ]
                index_ranges = [range(data_array.sizes[dimension]) for dimension in extra_dimensions]
                combinations = itertools.product(*index_ranges) if index_ranges else [()]
                for combination in combinations:
                    selectors = dict(zip(extra_dimensions, combination))
                    sliced = data_array.isel(selectors) if selectors else data_array
                    sliced = sliced.transpose(*spatial_dimensions)
                    latitudes, longitudes, heights = np.broadcast_arrays(
                        latitude.values,
                        longitude.values,
                        sliced.values,
                    )
                    cell = nearest_finite_grid_cell(
                        latitudes.reshape(-1).tolist(),
                        longitudes.reshape(-1).tolist(),
                        heights.reshape(-1).tolist(),
                        target_latitude=mapping.target_latitude,
                        target_longitude=mapping.target_longitude,
                        max_distance_km=mapping.max_grid_distance_km,
                    )
                    valid_at = _datetime_from_array_value(
                        _select_coordinate_value(data_array, dataset, selectors)
                    )
                    if valid_at < item.wmo_issue_at:
                        raise NdfdGribExtractionError(
                            f"{item.key} contained retrospective valid time "
                            f"{valid_at.isoformat()} before issue {item.wmo_issue_at.isoformat()}"
                        )
                    lead_hours = (valid_at - item.wmo_issue_at).total_seconds() / 3600
                    results.append(
                        NdfdPointForecast(
                            forecast_id=f"{item.key}:{valid_at.isoformat()}",
                            source_key=item.key,
                            source_etag=item.etag,
                            source_sha256=payload_sha256,
                            wmo_code=item.wmo_code,
                            issued_at=item.wmo_issue_at,
                            valid_at=valid_at,
                            lead_hours=lead_hours,
                            raw_wave_height_m=cell.wave_height_m,
                            grid_latitude=cell.latitude,
                            grid_longitude=cell.longitude,
                            grid_distance_km=cell.distance_km,
                        )
                    )
        if not results:
            raise NdfdGribExtractionError(
                f"{item.key} had no decodable finite shww point forecasts"
            )
        unique: dict[datetime, NdfdPointForecast] = {}
        for row in sorted(results, key=lambda value: value.valid_at):
            existing = unique.get(row.valid_at)
            if existing is not None and not math.isclose(
                existing.raw_wave_height_m,
                row.raw_wave_height_m,
                abs_tol=1e-9,
            ):
                raise NdfdGribExtractionError(
                    f"{item.key} produced conflicting shww values at {row.valid_at.isoformat()}"
                )
            unique[row.valid_at] = row
        return tuple(unique.values())


def extract_ndfd_point_forecasts(
    snapshots: Sequence[NdfdArchiveSnapshot],
    archive: NdfdArchiveSource,
    extractor: NdfdPointExtractor,
    mapping: NdfdMopHistoryMapping,
    *,
    max_object_bytes: int = 25_000_000,
) -> tuple[NdfdPointForecast, ...]:
    if max_object_bytes <= 0:
        raise ValueError("max_object_bytes must be positive")
    objects = {
        item.key: item
        for snapshot in snapshots
        for item in snapshot.objects
    }
    rows: list[NdfdPointForecast] = []
    for key in sorted(objects):
        item = objects[key]
        payload = archive.download(item, max_bytes=max_object_bytes)
        extracted = extractor.extract(payload, item, mapping)
        if not extracted:
            raise NdfdGribExtractionError(f"point extractor returned no rows for {key}")
        rows.extend(extracted)
    return tuple(
        sorted(
            rows,
            key=lambda row: (row.issued_at, row.valid_at, row.wmo_code, row.forecast_id),
        )
    )


def evaluate_ndfd_mop_history(
    point_forecasts: Sequence[NdfdPointForecast],
    cdip_values: Sequence[CdipMopValue],
    mapping: NdfdMopHistoryMapping,
    *,
    train_cutoff: datetime,
    snapshots: Sequence[NdfdArchiveSnapshot],
    cdip_metadata: CdipMopMetadata,
    config: EvaluationConfig | None = None,
) -> NdfdMopHistoryReport:
    cutoff = _utc(train_cutoff, field_name="train_cutoff")
    train_rows = [row.as_wave_forecast() for row in point_forecasts if row.issued_at <= cutoff]
    holdout_rows = [row.as_wave_forecast() for row in point_forecasts if row.issued_at > cutoff]
    if not train_rows or not holdout_rows:
        raise ValueError(
            "train_cutoff must leave at least one issued forecast in both train and holdout"
        )
    cdip_mapping = mapping.cdip_mapping()
    train = evaluate_fixed_transform_against_cdip(
        train_rows,
        cdip_values,
        cdip_mapping,
        config=config,
        metadata=cdip_metadata,
    )
    holdout = evaluate_fixed_transform_against_cdip(
        holdout_rows,
        cdip_values,
        cdip_mapping,
        config=config,
        metadata=cdip_metadata,
    )
    common_context: dict[str, str | int | float | bool | None] = {
        "train_cutoff": cutoff.isoformat(),
        "selection_rule": "latest object with WMO issue and S3 availability <= requested_as_of",
        "ndfd_reference": "NOAA NDFD public S3 WMO waveh archive",
        "cdip_reference_is_breaking_wave_truth": False,
    }
    train = train.model_copy(
        update={"context": {**train.context, **common_context, "partition": "train"}}
    )
    holdout = holdout.model_copy(
        update={"context": {**holdout.context, **common_context, "partition": "holdout"}}
    )
    return NdfdMopHistoryReport(
        mapping=mapping,
        train_cutoff=cutoff,
        snapshots=tuple(snapshots),
        point_forecasts=tuple(point_forecasts),
        cdip_metadata=cdip_metadata,
        train=train,
        holdout=holdout,
    )


def write_ndfd_mop_history_artifacts(
    report: NdfdMopHistoryReport,
    *,
    json_path: Path | None = None,
    samples_jsonl_path: Path | None = None,
) -> str:
    document = json.dumps(report.model_dump(mode="json"), indent=2, sort_keys=True)
    if json_path is not None:
        json_path.write_text(f"{document}\n")
    if samples_jsonl_path is not None:
        lines: list[str] = []
        for partition, evaluation in (("train", report.train), ("holdout", report.holdout)):
            for sample in evaluation.samples:
                lines.append(
                    json.dumps(
                        {"partition": partition, **sample.model_dump(mode="json")},
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                )
        samples_jsonl_path.write_text("\n".join(lines) + ("\n" if lines else ""))
    return document
