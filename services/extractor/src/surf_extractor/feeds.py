from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl


class BoundingBox(BaseModel):
    left_lon: float = Field(..., ge=-180, le=180)
    right_lon: float = Field(..., ge=-180, le=180)
    top_lat: float = Field(..., ge=-90, le=90)
    bottom_lat: float = Field(..., ge=-90, le=90)


class GfsWaveRequest(BaseModel):
    cycle: datetime
    forecast_hour: int = Field(..., ge=0)
    domain: Literal["global", "wcoast"] = "wcoast"
    bbox: BoundingBox
    variables: tuple[str, ...] = (
        "HTSGW",
        "PERPW",
        "DIRPW",
        "WVHGT",
        "SWELL",
    )

    def nomads_filter_url(self) -> str:
        cycle = self.cycle.astimezone(timezone.utc)
        ymd = cycle.strftime("%Y%m%d")
        hour = cycle.strftime("%H")
        fff = f"{self.forecast_hour:03d}"
        file_name = f"gfswave.t{hour}z.{self.domain}.0p16.f{fff}.grib2"
        params = {
            "dir": f"/gfs.{ymd}/{hour}/wave/gridded",
            "file": file_name,
            "subregion": "",
            "leftlon": str(self.bbox.left_lon),
            "rightlon": str(self.bbox.right_lon),
            "toplat": str(self.bbox.top_lat),
            "bottomlat": str(self.bbox.bottom_lat),
        }
        for variable in self.variables:
            params[f"var_{variable}"] = "on"
        query = "&".join(f"{key}={value}" for key, value in params.items())
        return f"https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl?{query}"


class CdipDataset(BaseModel):
    station_or_model_point: str
    dataset_url: HttpUrl
    role: Literal["observed_wave", "forecast_wave_nearshore"]


def norcal_bbox() -> BoundingBox:
    return BoundingBox(left_lon=-124.0, right_lon=-121.5, top_lat=38.5, bottom_lat=36.9)


def latest_complete_cycle(now: datetime | None = None) -> datetime:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cycle_hour = (current.hour // 6) * 6
    if current.hour == cycle_hour and current.minute < 45:
        cycle_hour = (cycle_hour - 6) % 24
    return current.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
