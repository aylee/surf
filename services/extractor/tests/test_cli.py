import json
from pathlib import Path

from click.testing import CliRunner

from surf_extractor.cli import main


def test_evaluate_jsonl_command_writes_reproducible_artifacts() -> None:
    runner = CliRunner()
    with runner.isolated_filesystem():
        forecast_path = Path("forecasts.jsonl")
        observation_path = Path("observations.jsonl")
        output_path = Path("evaluation.json")
        samples_path = Path("samples.jsonl")
        forecast_path.write_text(
            json.dumps(
                {
                    "source_id": "ndfd-waveh",
                    "model_cycle_at": "2025-01-01T00:00:00Z",
                    "forecast_at": "2025-01-01T06:00:00Z",
                    "offshore_height_m": 2.0,
                    "peak_period_s": 12,
                    "primary_direction_deg": 359,
                }
            )
            + "\n"
        )
        observation_path.write_text(
            json.dumps(
                {
                    "source_id": "cdip-mop",
                    "observed_at": "2025-01-01T06:00:00Z",
                    "wave_height_m": 1.8,
                    "peak_period_s": 11,
                    "direction_deg": 1,
                }
            )
            + "\n"
        )

        result = runner.invoke(
            main,
            [
                "evaluate-jsonl",
                "--forecast-jsonl",
                str(forecast_path),
                "--observation-jsonl",
                str(observation_path),
                "--output-json",
                str(output_path),
                "--samples-jsonl",
                str(samples_path),
            ],
        )

        assert result.exit_code == 0, result.output
        document = json.loads(output_path.read_text())
        assert document["metrics"]["wave_height"]["mae"] == 0.2
        assert document["metrics"]["direction"]["mae"] == 2
        assert len(samples_path.read_text().splitlines()) == 1


def test_old_observation_summary_is_not_exposed_as_a_backtest() -> None:
    result = CliRunner().invoke(main, ["--help"])

    assert result.exit_code == 0
    assert "summarize-ndbc-history" in result.output
    assert "backtest-ndbc-history" not in result.output
