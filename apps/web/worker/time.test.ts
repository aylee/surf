import { describe, expect, it } from "vitest";
import {
  stableHourlyForecastTimes,
  stableThreeHourForecastTimes,
  solarPhasesForDates,
  threeHourValidityFor
} from "./time";

describe("forecast clock projection", () => {
  it("builds stable hourly timestamps without inventing sub-hour values", () => {
    expect(stableHourlyForecastTimes(new Date("2026-07-10T02:53:07.000Z"), 3)).toEqual([
      "2026-07-10T03:00:00.000Z",
      "2026-07-10T04:00:00.000Z",
      "2026-07-10T05:00:00.000Z",
      "2026-07-10T06:00:00.000Z"
    ]);
  });

  it("maps each hourly timestamp to the containing local-clock three-hour state", () => {
    expect(threeHourValidityFor("2026-07-10T03:00:00.000Z", "America/Los_Angeles")).toEqual({
      validFrom: "2026-07-10T01:00:00.000Z",
      validTo: "2026-07-10T04:00:00.000Z"
    });
    expect(threeHourValidityFor("2026-07-10T04:00:00.000Z", "America/Los_Angeles")).toEqual({
      validFrom: "2026-07-10T04:00:00.000Z",
      validTo: "2026-07-10T07:00:00.000Z"
    });
  });

  it("uses the next local three-hour boundary through daylight-saving gaps and folds", () => {
    expect(threeHourValidityFor("2026-03-08T09:00:00.000Z", "America/Los_Angeles")).toEqual({
      validFrom: "2026-03-08T08:00:00.000Z",
      validTo: "2026-03-08T10:00:00.000Z"
    });
    expect(threeHourValidityFor("2026-11-01T09:00:00.000Z", "America/Los_Angeles")).toEqual({
      validFrom: "2026-11-01T07:00:00.000Z",
      validTo: "2026-11-01T11:00:00.000Z"
    });
  });

  it("retains the existing local-clock three-hour cadence", () => {
    expect(
      stableThreeHourForecastTimes(
        new Date("2026-07-10T02:53:07.000Z"),
        6,
        "America/Los_Angeles"
      )
    ).toEqual([
      "2026-07-10T04:00:00.000Z",
      "2026-07-10T07:00:00.000Z",
      "2026-07-10T10:00:00.000Z"
    ]);
  });

  it("computes ordered civil-light phases on the requested Pacific local date", () => {
    const [phases] = solarPhasesForDates(["2026-07-10"], {
      lat: 37.759,
      lon: -122.51,
      timeZone: "America/Los_Angeles"
    });

    expect(phases?.localDate).toBe("2026-07-10");
    const instants = [
      phases!.firstLight,
      phases!.sunrise,
      phases!.sunset,
      phases!.lastLight
    ].map((value) => new Date(value).getTime());
    expect(instants).toEqual([...instants].sort((left, right) => left - right));
    expect(phases?.sunrise).toMatch(/^2026-07-10T12:/);
    expect(phases?.sunset).toMatch(/^2026-07-11T03:/);
  });
});
