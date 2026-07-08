from __future__ import annotations

import shutil
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


NOMADS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl"
NOMADS_GFS_DATA_URL = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
GFSWAVE_SOURCE_ID = "noaa-gfswave-wcoast-0p16"
GFSWAVE_DOMAIN = "wcoast"
GFSWAVE_GRID = "0p16"
GFSWAVE_REQUIRED_VARIABLES = ("HTSGW", "PERPW", "DIRPW")
GFSWAVE_DEFAULT_VARIABLES = (
    "HTSGW",
    "PERPW",
    "DIRPW",
    "WVHGT",
    "WVPER",
    "WVDIR",
    "SWELL",
    "SWPER",
    "SWDIR",
)
GFSWAVE_DEFAULT_LEVELS = (
    "surface",
    "1 in sequence",
    "2 in sequence",
    "3 in sequence",
)
GFSWAVE_V1_FORECAST_HOURS = tuple(range(0, 73, 3))


class BoundingBox(BaseModel):
    left_lon: float = Field(..., ge=-180, le=180)
    right_lon: float = Field(..., ge=-180, le=180)
    top_lat: float = Field(..., ge=-90, le=90)
    bottom_lat: float = Field(..., ge=-90, le=90)

    @model_validator(mode="after")
    def validate_bounds(self) -> BoundingBox:
        if self.left_lon >= self.right_lon:
            raise ValueError("left_lon must be west of right_lon")
        if self.bottom_lat >= self.top_lat:
            raise ValueError("bottom_lat must be south of top_lat")
        return self


class GfsWaveRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    cycle: datetime
    forecast_hour: int = Field(..., ge=0, le=384)
    bbox: BoundingBox
    source_id: str = GFSWAVE_SOURCE_ID
    domain: str = GFSWAVE_DOMAIN
    grid: str = GFSWAVE_GRID
    variables: tuple[str, ...] = GFSWAVE_DEFAULT_VARIABLES
    levels: tuple[str, ...] = GFSWAVE_DEFAULT_LEVELS
    region_slug: str = "norcal"

    @model_validator(mode="after")
    def validate_wcoast_shape(self) -> GfsWaveRequest:
        if self.domain != GFSWAVE_DOMAIN or self.grid != GFSWAVE_GRID:
            raise ValueError("v1 only supports the NOAA GFSwave West Coast 0p16 grid")
        if not set(GFSWAVE_REQUIRED_VARIABLES).issubset(set(self.variables)):
            required = ", ".join(GFSWAVE_REQUIRED_VARIABLES)
            raise ValueError(f"GFSwave request must include required variables: {required}")
        return self

    @property
    def cycle_utc(self) -> datetime:
        return ensure_utc(self.cycle)

    @property
    def forecast_time(self) -> datetime:
        return self.cycle_utc + timedelta(hours=self.forecast_hour)

    @property
    def cycle_ymd(self) -> str:
        return self.cycle_utc.strftime("%Y%m%d")

    @property
    def cycle_hour(self) -> str:
        return self.cycle_utc.strftime("%H")

    @property
    def forecast_hour_slug(self) -> str:
        return f"f{self.forecast_hour:03d}"

    @property
    def file_name(self) -> str:
        return (
            f"gfswave.t{self.cycle_hour}z."
            f"{self.domain}.{self.grid}.{self.forecast_hour_slug}.grib2"
        )

    @property
    def nomads_dir(self) -> str:
        return f"/gfs.{self.cycle_ymd}/{self.cycle_hour}/wave/gridded"

    @property
    def r2_key(self) -> str:
        return "/".join(
            (
                "raw",
                self.source_id,
                f"cycle={self.cycle_ymd}{self.cycle_hour}",
                f"lead={self.forecast_hour_slug}",
                f"{self.region_slug}.grib2",
            )
        )

    def nomads_filter_url(self) -> str:
        params: dict[str, str] = {
            "dir": self.nomads_dir,
            "file": self.file_name,
            "subregion": "",
            "leftlon": format_lonlat(self.bbox.left_lon),
            "rightlon": format_lonlat(self.bbox.right_lon),
            "toplat": format_lonlat(self.bbox.top_lat),
            "bottomlat": format_lonlat(self.bbox.bottom_lat),
        }
        for level in self.levels:
            params[f"lev_{level.replace(' ', '_')}"] = "on"
        for variable in self.variables:
            params[f"var_{variable}"] = "on"
        return f"{NOMADS_FILTER_URL}?{urlencode(params)}"

    def inventory_url(self) -> str:
        return (
            f"{NOMADS_GFS_DATA_URL}/gfs.{self.cycle_ymd}/{self.cycle_hour}"
            f"/wave/gridded/{self.file_name}.idx"
        )

    def artifact_plan(self) -> GfsWaveArtifactPlan:
        return GfsWaveArtifactPlan(
            source_id=self.source_id,
            cycle=self.cycle_utc,
            lead_hour=self.forecast_hour,
            forecast_time=self.forecast_time,
            filter_url=self.nomads_filter_url(),
            inventory_url=self.inventory_url(),
            r2_key=self.r2_key,
            variables=self.variables,
        )


class GfsWaveArtifactPlan(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_id: str
    cycle: datetime
    lead_hour: int = Field(..., ge=0)
    forecast_time: datetime
    filter_url: str
    inventory_url: str
    r2_key: str
    variables: tuple[str, ...]


class GfsWaveInventoryRecord(BaseModel):
    model_config = ConfigDict(frozen=True)

    record_number: int = Field(..., ge=1)
    byte_offset: int = Field(..., ge=0)
    reference_time: str
    variable: str
    level: str
    forecast_label: str
    raw_line: str


class GfsWaveInventory(BaseModel):
    model_config = ConfigDict(frozen=True)

    request: GfsWaveRequest
    records: tuple[GfsWaveInventoryRecord, ...]

    @property
    def variables(self) -> tuple[str, ...]:
        return tuple(sorted({record.variable for record in self.records}))

    def missing_variables(self, variables: Iterable[str]) -> tuple[str, ...]:
        available = set(self.variables)
        return tuple(variable for variable in variables if variable not in available)


class GfsWaveCyclePlan(BaseModel):
    model_config = ConfigDict(frozen=True)

    cycle: datetime
    artifacts: tuple[GfsWaveArtifactPlan, ...]

    @property
    def lead_hours(self) -> tuple[int, ...]:
        return tuple(artifact.lead_hour for artifact in self.artifacts)


class GfsWavePoint(BaseModel):
    model_config = ConfigDict(frozen=True)

    point_id: str
    lat: float = Field(..., ge=-90, le=90)
    lon: float = Field(..., ge=-180, le=180)


class GfsWavePointForecast(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_id: str
    point_id: str
    lat: float
    lon: float
    cycle: datetime
    lead_hour: int = Field(..., ge=0)
    forecast_time: datetime
    r2_key: str
    wave_height_m: float | None = Field(default=None, ge=0)
    peak_period_s: float | None = Field(default=None, ge=0)
    primary_direction_deg: float | None = Field(default=None, ge=0, le=360)
    raw_values: dict[str, float | None] = Field(default_factory=dict)


class GribToolingStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    wgrib2: bool
    cfgrib: bool
    xarray: bool

    @property
    def can_extract_points(self) -> bool:
        return self.wgrib2 or (self.cfgrib and self.xarray)


class GfsWaveError(RuntimeError):
    """Base error for GFSwave planning and validation failures."""


class GfsWaveInventoryUnavailable(GfsWaveError):
    """Raised when a NOMADS inventory URL is missing or unavailable."""


class GfsWaveInventoryValidationError(GfsWaveError):
    """Raised when an inventory is present but does not contain needed fields."""


class GfsWaveCycleUnavailable(GfsWaveError):
    """Raised when no complete cycle can be selected."""


class CdipDataset(BaseModel):
    station_or_model_point: str
    dataset_url: HttpUrl
    role: Literal["observed_wave", "forecast_wave_nearshore"]


def norcal_bbox() -> BoundingBox:
    return BoundingBox(left_lon=-124.0, right_lon=-121.5, top_lat=38.5, bottom_lat=36.9)


def ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def format_lonlat(value: float) -> str:
    return str(int(value)) if value == int(value) else str(value)


def latest_complete_cycle(
    now: datetime | None = None,
    minimum_cycle_age: timedelta = timedelta(minutes=45),
) -> datetime:
    current = ensure_utc(now or datetime.now(timezone.utc)) - minimum_cycle_age
    cycle_hour = (current.hour // 6) * 6
    return current.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)


def candidate_gfswave_cycles(
    now: datetime | None = None,
    *,
    max_cycles: int = 8,
    minimum_cycle_age: timedelta = timedelta(minutes=45),
) -> tuple[datetime, ...]:
    start = latest_complete_cycle(now, minimum_cycle_age=minimum_cycle_age)
    return tuple(start - timedelta(hours=6 * offset) for offset in range(max_cycles))


def build_gfswave_requests(
    cycle: datetime,
    *,
    forecast_hours: Sequence[int] = GFSWAVE_V1_FORECAST_HOURS,
    bbox: BoundingBox | None = None,
    variables: tuple[str, ...] = GFSWAVE_DEFAULT_VARIABLES,
) -> tuple[GfsWaveRequest, ...]:
    return tuple(
        GfsWaveRequest(
            cycle=ensure_utc(cycle),
            forecast_hour=forecast_hour,
            bbox=bbox or norcal_bbox(),
            variables=variables,
        )
        for forecast_hour in forecast_hours
    )


def build_gfswave_cycle_plan(
    cycle: datetime,
    *,
    forecast_hours: Sequence[int] = GFSWAVE_V1_FORECAST_HOURS,
    bbox: BoundingBox | None = None,
    variables: tuple[str, ...] = GFSWAVE_DEFAULT_VARIABLES,
) -> GfsWaveCyclePlan:
    artifacts = tuple(
        request.artifact_plan()
        for request in build_gfswave_requests(
            cycle,
            forecast_hours=forecast_hours,
            bbox=bbox,
            variables=variables,
        )
    )
    return GfsWaveCyclePlan(cycle=ensure_utc(cycle), artifacts=artifacts)


def parse_gfswave_inventory(text: str, request: GfsWaveRequest) -> GfsWaveInventory:
    records: list[GfsWaveInventoryRecord] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split(":")
        if len(parts) < 6:
            continue
        try:
            record_number = int(parts[0])
            byte_offset = int(parts[1])
        except ValueError:
            continue
        records.append(
            GfsWaveInventoryRecord(
                record_number=record_number,
                byte_offset=byte_offset,
                reference_time=parts[2],
                variable=parts[3],
                level=parts[4],
                forecast_label=parts[5],
                raw_line=line,
            )
        )
    if not records:
        raise GfsWaveInventoryUnavailable(
            f"No GRIB inventory records found for {request.file_name}"
        )
    return GfsWaveInventory(request=request, records=tuple(records))


def validate_gfswave_inventory(
    text: str,
    request: GfsWaveRequest,
    *,
    required_variables: Sequence[str] = GFSWAVE_REQUIRED_VARIABLES,
) -> GfsWaveInventory:
    inventory = parse_gfswave_inventory(text, request)
    missing = inventory.missing_variables(required_variables)
    if missing:
        raise GfsWaveInventoryValidationError(
            f"{request.file_name} is missing required variables: {', '.join(missing)}"
        )
    return inventory


def fetch_gfswave_inventory(request: GfsWaveRequest, *, timeout: float = 20.0) -> str:
    try:
        response = httpx.get(request.inventory_url(), timeout=timeout)
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise GfsWaveInventoryUnavailable(
            f"{request.inventory_url()} returned HTTP {exc.response.status_code}"
        ) from exc
    except httpx.HTTPError as exc:
        raise GfsWaveInventoryUnavailable(
            f"{request.inventory_url()} could not be fetched: {exc}"
        ) from exc
    return response.text


InventoryFetcher = Callable[[GfsWaveRequest], str]


def select_latest_complete_gfswave_cycle(
    *,
    now: datetime | None = None,
    forecast_hours: Sequence[int] = GFSWAVE_V1_FORECAST_HOURS,
    fetch_inventory_text: InventoryFetcher = fetch_gfswave_inventory,
    max_cycles: int = 8,
    minimum_cycle_age: timedelta = timedelta(minutes=45),
    bbox: BoundingBox | None = None,
    variables: tuple[str, ...] = GFSWAVE_DEFAULT_VARIABLES,
) -> GfsWaveCyclePlan:
    failures: list[str] = []
    for cycle in candidate_gfswave_cycles(
        now,
        max_cycles=max_cycles,
        minimum_cycle_age=minimum_cycle_age,
    ):
        requests = build_gfswave_requests(
            cycle,
            forecast_hours=forecast_hours,
            bbox=bbox,
            variables=variables,
        )
        try:
            for request in requests:
                inventory_text = fetch_inventory_text(request)
                validate_gfswave_inventory(inventory_text, request)
        except GfsWaveError as exc:
            failures.append(f"{cycle.isoformat()}: {exc}")
            continue
        return build_gfswave_cycle_plan(
            cycle,
            forecast_hours=forecast_hours,
            bbox=bbox,
            variables=variables,
        )
    detail = "; ".join(failures) if failures else "no candidate cycles were checked"
    raise GfsWaveCycleUnavailable(f"No complete GFSwave cycle found: {detail}")


def normalize_gfswave_point_forecast(
    artifact: GfsWaveArtifactPlan,
    point: GfsWavePoint,
    values: Mapping[str, float | None],
) -> GfsWavePointForecast:
    return GfsWavePointForecast(
        source_id=artifact.source_id,
        point_id=point.point_id,
        lat=point.lat,
        lon=point.lon,
        cycle=artifact.cycle,
        lead_hour=artifact.lead_hour,
        forecast_time=artifact.forecast_time,
        r2_key=artifact.r2_key,
        wave_height_m=values.get("HTSGW"),
        peak_period_s=values.get("PERPW"),
        primary_direction_deg=values.get("DIRPW"),
        raw_values=dict(values),
    )


def normalize_gfswave_point_series(
    cycle_plan: GfsWaveCyclePlan,
    point: GfsWavePoint,
    values_by_lead_hour: Mapping[int, Mapping[str, float | None]],
) -> tuple[GfsWavePointForecast, ...]:
    return tuple(
        normalize_gfswave_point_forecast(
            artifact,
            point,
            values_by_lead_hour.get(artifact.lead_hour, {}),
        )
        for artifact in cycle_plan.artifacts
    )


def grib_tooling_status() -> GribToolingStatus:
    return GribToolingStatus(
        wgrib2=shutil.which("wgrib2") is not None,
        cfgrib=module_available("cfgrib"),
        xarray=module_available("xarray"),
    )


def module_available(module_name: str) -> bool:
    try:
        __import__(module_name)
    except ImportError:
        return False
    return True
