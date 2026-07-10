import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from surf_extractor.backtest import EvaluationConfig
from surf_extractor.cdip import CdipMopMetadata, CdipMopValue
from surf_extractor.ndfd_history import (
    CfgribNdfdPointExtractor,
    NdfdArchiveObject,
    NdfdArchiveSelectionError,
    NdfdArchiveSnapshot,
    NdfdArchiveUnavailable,
    NdfdGribExtractionError,
    NdfdMopHistoryMapping,
    NdfdPointForecast,
    NdfdS3ArchiveClient,
    evaluate_ndfd_mop_history,
    extract_ndfd_point_forecasts,
    nearest_finite_grid_cell,
    parse_ndfd_s3_listing,
    select_ndfd_archive_snapshots,
    validate_issue_snapshots,
    write_ndfd_mop_history_artifacts,
)


UTC = timezone.utc


def utc(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2025, 4, day, hour, minute, tzinfo=UTC)


def mapping() -> NdfdMopHistoryMapping:
    return NdfdMopHistoryMapping(
        spot_id="bolinas",
        target_latitude=37.909,
        target_longitude=-122.730,
        cdip_point_id="M0001",
        cdip_nowcast_url=(
            "https://thredds.cdip.ucsd.edu/thredds/dodsC/"
            "cdip/model/MOP_alongshore/M0001_nowcast.nc"
        ),
        current_height_scale=0.65,
        max_grid_distance_km=5,
    )


def archive_object(
    code: str,
    issue_at: datetime,
    *,
    last_modified: datetime | None = None,
    size_bytes: int = 4,
) -> NdfdArchiveObject:
    return NdfdArchiveObject(
        key=(
            f"wmo/waveh/{issue_at:%Y/%m/%d}/{code}_{issue_at:%Y%m%d%H%M}"
        ),
        wmo_code=code,
        wmo_issue_at=issue_at,
        last_modified=last_modified or issue_at + timedelta(minutes=2),
        etag=f"etag-{code}-{issue_at:%H%M}",
        size_bytes=size_bytes,
    )


def listing_xml(*objects: NdfdArchiveObject, truncated: bool = False) -> str:
    contents = "".join(
        (
            "<Contents>"
            f"<Key>{item.key}</Key>"
            f"<LastModified>{item.last_modified.isoformat().replace('+00:00', 'Z')}</LastModified>"
            f"<ETag>&quot;{item.etag}&quot;</ETag>"
            f"<Size>{item.size_bytes}</Size>"
            "</Contents>"
        )
        for item in objects
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        f"<IsTruncated>{str(truncated).lower()}</IsTruncated>"
        f"{contents}</ListBucketResult>"
    )


def test_mapping_requires_an_explicit_mop_nowcast() -> None:
    payload = mapping().model_dump(mode="json")
    payload["cdip_nowcast_url"] = payload["cdip_nowcast_url"].replace(
        "_nowcast.nc", "_forecast.nc"
    )

    with pytest.raises(ValueError, match="nowcast"):
        NdfdMopHistoryMapping.model_validate(payload)


def test_parse_s3_listing_preserves_wmo_issue_and_availability() -> None:
    item = archive_object("YKUZ98_KWBN", utc(1, 4, 7))

    rows = parse_ndfd_s3_listing(listing_xml(item))

    assert rows == (item,)
    with pytest.raises(NdfdArchiveUnavailable, match="bounded request"):
        parse_ndfd_s3_listing(listing_xml(item, truncated=True))


def test_s3_client_uses_bounded_prefix_and_size_guard() -> None:
    item = archive_object("YKUZ98_KWBN", utc(1, 4, 7))
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/":
            return httpx.Response(200, text=listing_xml(item), request=request)
        return httpx.Response(200, content=b"grib", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        archive = NdfdS3ArchiveClient(client)
        assert archive.list_day(date(2025, 4, 1), "YKUZ98_KWBN") == (item,)
        assert archive.download(item, max_bytes=4) == b"grib"
        with pytest.raises(NdfdArchiveUnavailable, match="max_bytes"):
            archive.download(item, max_bytes=3)

    assert requests[0].url.params["max-keys"] == "1000"
    assert requests[0].url.params["prefix"].endswith("YKUZ98_KWBN_20250401")


class FakeArchive:
    def __init__(self, rows: list[NdfdArchiveObject]) -> None:
        self.rows = rows
        self.downloaded: list[str] = []

    def list_day(self, day: date, wmo_code: str) -> tuple[NdfdArchiveObject, ...]:
        return tuple(
            item
            for item in self.rows
            if item.wmo_issue_at.date() == day and item.wmo_code == wmo_code
        )

    def download(self, item: NdfdArchiveObject, *, max_bytes: int) -> bytes:
        assert item.size_bytes <= max_bytes
        self.downloaded.append(item.key)
        return b"grib"


def test_snapshot_selection_never_uses_future_issue_or_upload() -> None:
    as_of = utc(1, 4, 30)
    short_available = archive_object("YKUZ98_KWBN", utc(1, 4, 7))
    short_not_uploaded = archive_object(
        "YKUZ98_KWBN",
        utc(1, 4, 27),
        last_modified=utc(1, 4, 31),
    )
    short_future = archive_object("YKUZ98_KWBN", utc(1, 4, 47))
    long_previous_day = archive_object(
        "YKUZ97_KWBN",
        datetime(2025, 3, 31, 23, 33, tzinfo=UTC),
    )
    archive = FakeArchive(
        [short_available, short_not_uploaded, short_future, long_previous_day]
    )

    snapshot = select_ndfd_archive_snapshots([as_of], archive)[0]

    selected = {item.wmo_code: item for item in snapshot.objects}
    assert selected["YKUZ98_KWBN"] == short_available
    assert selected["YKUZ97_KWBN"] == long_previous_day
    assert all(item.last_modified <= as_of for item in snapshot.objects)


def test_snapshot_selection_fails_instead_of_filling_missing_code() -> None:
    with pytest.raises(NdfdArchiveSelectionError, match="YKUZ97"):
        select_ndfd_archive_snapshots(
            [utc(1, 5)],
            FakeArchive([archive_object("YKUZ98_KWBN", utc(1, 4, 7))]),
        )


def test_issue_snapshots_must_be_explicit_and_chronological() -> None:
    with pytest.raises(ValueError, match="strictly chronological"):
        validate_issue_snapshots([utc(2, 4), utc(1, 4)])
    with pytest.raises(ValueError, match="UTC offset"):
        validate_issue_snapshots([datetime(2025, 4, 1)])


def test_nearest_grid_cell_skips_missing_and_normalizes_longitude() -> None:
    cell = nearest_finite_grid_cell(
        [37.909, 37.9017183286, 38.2],
        [237.27, 237.2691012146, 237.0],
        [float("nan"), 1.5, 8.0],
        target_latitude=37.909,
        target_longitude=-122.730,
        max_distance_km=5,
    )

    assert cell.latitude == 37.9017183286
    assert cell.longitude == pytest.approx(-122.7308987854)
    assert cell.wave_height_m == 1.5
    assert cell.distance_km == pytest.approx(0.8121, abs=0.002)

    with pytest.raises(NdfdGribExtractionError, match="max_grid_distance"):
        nearest_finite_grid_cell(
            [38.2],
            [237.0],
            [8.0],
            target_latitude=37.909,
            target_longitude=-122.730,
            max_distance_km=5,
        )


def test_cfgrib_extractor_keeps_coordinate_value_association(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    np = pytest.importorskip("numpy", reason="optional GRIB dependencies are not installed")
    xr = pytest.importorskip("xarray", reason="optional GRIB dependencies are not installed")
    cfgrib = pytest.importorskip(
        "cfgrib", reason="optional GRIB dependencies are not installed"
    )
    issue_at = utc(1, 4, 7)
    dataset = xr.Dataset(
        data_vars={
            "shww": (
                ("step", "y", "x"),
                np.array(
                    [
                        [[8.8, 7.7], [6.6, 1.5]],
                        [[8.8, 7.7], [2.2, np.nan]],
                    ]
                ),
                {"units": "m", "GRIB_shortName": "shww"},
            )
        },
        coords={
            "step": [0, 1],
            "valid_time": (
                "step",
                np.array(["2025-04-01T05:07", "2025-04-01T06:07"], dtype="datetime64[ns]"),
            ),
            "latitude": (
                ("y", "x"),
                np.array([[37.90, 37.90], [37.91, 37.91]]),
            ),
            "longitude": (
                ("y", "x"),
                np.array([[237.26, 237.27], [237.26, 237.27]]),
            ),
        },
    )
    payload = b"synthetic-grib-boundary"

    def open_synthetic(path: str, *, backend_kwargs: dict[str, str]):
        assert Path(path).read_bytes() == payload
        assert backend_kwargs == {"indexpath": ""}
        return [dataset]

    monkeypatch.setattr(cfgrib, "open_datasets", open_synthetic)

    rows = CfgribNdfdPointExtractor().extract(
        payload,
        archive_object("YKUZ98_KWBN", issue_at, size_bytes=len(payload)),
        mapping(),
    )

    assert [row.valid_at for row in rows] == [
        datetime(2025, 4, 1, 5, 7, tzinfo=UTC),
        datetime(2025, 4, 1, 6, 7, tzinfo=UTC),
    ]
    assert rows[0].raw_wave_height_m == 1.5
    assert rows[0].grid_latitude == 37.91
    assert rows[0].grid_longitude == pytest.approx(-122.73)
    assert rows[1].raw_wave_height_m == 2.2
    assert rows[1].grid_latitude == 37.91
    assert rows[1].grid_longitude == pytest.approx(-122.74)


class FakeExtractor:
    def extract(
        self,
        payload: bytes,
        item: NdfdArchiveObject,
        target: NdfdMopHistoryMapping,
    ) -> tuple[NdfdPointForecast, ...]:
        assert payload == b"grib"
        valid_at = item.wmo_issue_at + timedelta(hours=6)
        return (
            NdfdPointForecast(
                forecast_id=f"{item.key}:value",
                source_key=item.key,
                source_etag=item.etag,
                source_sha256="a" * 64,
                wmo_code=item.wmo_code,
                issued_at=item.wmo_issue_at,
                valid_at=valid_at,
                lead_hours=6,
                raw_wave_height_m=2,
                grid_latitude=target.target_latitude,
                grid_longitude=target.target_longitude,
                grid_distance_km=0,
            ),
        )


def test_grib_extraction_abstraction_deduplicates_snapshot_objects() -> None:
    short = archive_object("YKUZ98_KWBN", utc(1, 4, 7))
    long = archive_object("YKUZ97_KWBN", utc(1, 3, 33))
    snapshots = [
        NdfdArchiveSnapshot(requested_as_of=utc(1, 4, 30), objects=(short, long)),
        NdfdArchiveSnapshot(requested_as_of=utc(1, 5, 0), objects=(short, long)),
    ]
    archive = FakeArchive([short, long])

    rows = extract_ndfd_point_forecasts(
        snapshots,
        archive,
        FakeExtractor(),
        mapping(),
    )

    assert len(rows) == 2
    assert len(archive.downloaded) == 2


def point_forecast(identifier: str, issued_at: datetime) -> NdfdPointForecast:
    valid_at = issued_at + timedelta(hours=6)
    return NdfdPointForecast(
        forecast_id=identifier,
        source_key=f"key-{identifier}",
        source_etag=f"etag-{identifier}",
        source_sha256="b" * 64,
        wmo_code="YKUZ98_KWBN",
        issued_at=issued_at,
        valid_at=valid_at,
        lead_hours=6,
        raw_wave_height_m=2,
        grid_latitude=37.9,
        grid_longitude=-122.7,
        grid_distance_km=1,
    )


def test_history_report_has_chronological_train_and_holdout(tmp_path: Path) -> None:
    train_row = point_forecast("train", utc(1, 0))
    holdout_row = point_forecast("holdout", utc(2, 0))
    cdip_values = [
        CdipMopValue(
            cdip_point_id="M0001",
            observed_at=train_row.valid_at,
            wave_height_m=1.3,
        ),
        CdipMopValue(
            cdip_point_id="M0001",
            observed_at=holdout_row.valid_at,
            wave_height_m=1.1,
        ),
    ]
    metadata = CdipMopMetadata(
        cdip_point_id="M0001",
        dataset_url=str(mapping().cdip_nowcast_url),
        variables=("waveTime", "waveHs"),
        wave_time_count=2,
    )

    report = evaluate_ndfd_mop_history(
        [train_row, holdout_row],
        cdip_values,
        mapping(),
        train_cutoff=utc(1, 12),
        snapshots=(),
        cdip_metadata=metadata,
        config=EvaluationConfig(match_tolerance_minutes=1),
    )
    json_path = tmp_path / "report.json"
    jsonl_path = tmp_path / "samples.jsonl"
    first = write_ndfd_mop_history_artifacts(
        report,
        json_path=json_path,
        samples_jsonl_path=jsonl_path,
    )

    assert report.train.metrics.forecast_count == 1
    assert report.holdout.metrics.forecast_count == 1
    assert report.train.metrics.wave_height.mae == 0
    assert report.holdout.metrics.wave_height.mae == 0.2
    assert report.holdout.context["partition"] == "holdout"
    assert (
        json.loads(first)["holdout"]["context"][
            "cdip_reference_is_breaking_wave_truth"
        ]
        is False
    )
    partitions = [json.loads(line)["partition"] for line in jsonl_path.read_text().splitlines()]
    assert partitions == ["train", "holdout"]
    assert json_path.read_text().endswith("\n")


def test_train_cutoff_cannot_leak_all_rows_into_one_partition() -> None:
    row = point_forecast("only", utc(1, 0))
    metadata = CdipMopMetadata(
        cdip_point_id="M0001",
        dataset_url=str(mapping().cdip_nowcast_url),
        variables=("waveTime", "waveHs"),
        wave_time_count=1,
    )
    with pytest.raises(ValueError, match="both train and holdout"):
        evaluate_ndfd_mop_history(
            [row],
            [
                CdipMopValue(
                    cdip_point_id="M0001",
                    observed_at=row.valid_at,
                    wave_height_m=1,
                )
            ],
            mapping(),
            train_cutoff=utc(2, 0),
            snapshots=(),
            cdip_metadata=metadata,
        )


def test_dated_scan_order_cross_check_fixture_is_tight_and_limited() -> None:
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "ndfd_scan_order_cross_check.json").read_text()
    )

    assert "not a general decoder proof" in fixture["scope"]
    assert fixture["ndfd_object_key"].endswith("YKUZ98_KWBN_202607100407")
    assert {row["spot_id"] for row in fixture["checks"]} == {
        "bolinas",
        "obsf-central",
    }
    for row in fixture["checks"]:
        assert row["grid_distance_km"] < 1.1
        assert row["absolute_delta_m"] <= 0.024
        assert abs(row["cfgrib_shww_m"] - row["nws_wave_height_m"]) == pytest.approx(
            row["absolute_delta_m"]
        )
