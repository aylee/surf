import { describe, expect, it } from "vitest";
import {
  forecastDisplayHorizonEnd,
  stableHourlyForecastTimes,
  stableThreeHourForecastTimes,
  solarPhasesForDates,
  threeHourValidityFor
} from "./time";

describe("forecast clock projection", () => {
  it("materializes every hourly slot in the current local date, including elapsed hours", () => {
    const times = stableHourlyForecastTimes(
      new Date("2026-07-10T18:53:07.000Z"),
      24,
      "America/Los_Angeles"
    );

    expect(times).toHaveLength(24);
    expect(times[0]).toBe("2026-07-10T07:00:00.000Z");
    expect(times.at(-1)).toBe("2026-07-11T06:00:00.000Z");
    expect(times).toContain("2026-07-10T08:00:00.000Z");
  });

  it("keeps the default horizon to exactly five complete local dates", () => {
    const timeZone = "America/Los_Angeles";
    const times = stableHourlyForecastTimes(
      new Date("2026-07-10T02:53:07.000Z"),
      120,
      timeZone
    );
    const localDates = [
      ...new Set(
        times.map((time) =>
          new Intl.DateTimeFormat("en-CA", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          }).format(new Date(time))
        )
      )
    ];

    expect(times).toHaveLength(120);
    expect(localDates).toEqual([
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
      "2026-07-13"
    ]);
  });

  it.each([
    ["normal", "2026-07-10T18:00:00.000Z", "2026-07-15T07:00:00.000Z"],
    ["spring-forward", "2026-03-08T18:00:00.000Z", "2026-03-13T07:00:00.000Z"],
    ["fall-back", "2026-11-01T18:00:00.000Z", "2026-11-06T08:00:00.000Z"]
  ])("ends the final %s display interval at the next local midnight", (_label, now, expected) => {
    const timeZone = "America/Los_Angeles";
    expect(
      forecastDisplayHorizonEnd(stableHourlyForecastTimes(new Date(now), 120, timeZone), "1h")
    ).toBe(expected);
    expect(
      forecastDisplayHorizonEnd(stableThreeHourForecastTimes(new Date(now), 120, timeZone), "3h")
    ).toBe(expected);
  });

  it("preserves 23- and 25-hour local dates through daylight-saving changes", () => {
    const timeZone = "America/Los_Angeles";
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const localHour = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23"
    });
    const spring = stableHourlyForecastTimes(
      new Date("2026-03-08T18:00:00.000Z"),
      120,
      timeZone
    );
    const fall = stableHourlyForecastTimes(
      new Date("2026-11-01T18:00:00.000Z"),
      120,
      timeZone
    );

    expect(spring).toHaveLength(23 + 4 * 24);
    expect(new Set(spring.map((time) => localDate.format(new Date(time))))).toEqual(
      new Set(["2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12"])
    );
    expect(
      spring
        .filter((time) => localDate.format(new Date(time)) === "2026-03-08")
        .map((time) => localHour.format(new Date(time)))
    ).not.toContain("02");
    expect(fall).toHaveLength(25 + 4 * 24);
    expect(new Set(fall.map((time) => localDate.format(new Date(time))))).toEqual(
      new Set(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"])
    );
    expect(
      fall.filter(
        (time) =>
          localDate.format(new Date(time)) === "2026-11-01" &&
          localHour.format(new Date(time)) === "01"
      )
    ).toHaveLength(2);

    const springThreeHour = stableThreeHourForecastTimes(
      new Date("2026-03-08T18:00:00.000Z"),
      120,
      timeZone
    );
    const fallThreeHour = stableThreeHourForecastTimes(
      new Date("2026-11-01T18:00:00.000Z"),
      120,
      timeZone
    );
    expect(springThreeHour).toHaveLength(5 * 8);
    expect(fallThreeHour).toHaveLength(5 * 8);
    expect(
      fallThreeHour.filter((time) => localDate.format(new Date(time)) === "2026-11-01")
    ).toHaveLength(8);
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

  it("materializes every local-clock three-hour slot in the current date", () => {
    expect(stableThreeHourForecastTimes(
      new Date("2026-07-10T02:53:07.000Z"),
      24,
      "America/Los_Angeles"
    )).toEqual([
      "2026-07-09T07:00:00.000Z",
      "2026-07-09T10:00:00.000Z",
      "2026-07-09T13:00:00.000Z",
      "2026-07-09T16:00:00.000Z",
      "2026-07-09T19:00:00.000Z",
      "2026-07-09T22:00:00.000Z",
      "2026-07-10T01:00:00.000Z",
      "2026-07-10T04:00:00.000Z"
    ]);

    expect(stableThreeHourForecastTimes(
      new Date("2026-11-01T18:00:00.000Z"),
      24,
      "America/Los_Angeles"
    ).slice(0, 2)).toEqual([
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T11:00:00.000Z"
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

  it("computes winter last light as a real clipping boundary", () => {
    const [phases] = solarPhasesForDates(["2026-12-21"], {
      lat: 37.759,
      lon: -122.51,
      timeZone: "America/Los_Angeles"
    });

    expect(phases?.sunset).toMatch(/^2026-12-22T00:/);
    expect(phases?.lastLight).toMatch(/^2026-12-22T01:/);
    expect(new Date(phases!.lastLight).getTime()).toBeGreaterThan(
      new Date(phases!.sunset).getTime()
    );
  });
});
