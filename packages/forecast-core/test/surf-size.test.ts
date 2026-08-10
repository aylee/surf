import { describe, expect, it } from "vitest";
import { surfSizeRange } from "../src/index";

describe("surfSizeRange", () => {
  const cases: Array<[number | null, string]> = [
    [null, "Size unavailable"],
    [Number.NaN, "Size unavailable"],
    [0, "0–1 ft"],
    [0.99, "0–1 ft"],
    [1, "0–1 ft"],
    [1.2, "1–2 ft"],
    [1.96, "1–2 ft"],
    [2, "1–2 ft"],
    [2.1, "2–3 ft"],
    [9.9, "9–10 ft"],
    [10, "10 ft+"],
    [10.6, "11 ft+"]
  ];

  it.each(cases)("maps %s to %s", (value, expected) => {
    expect(surfSizeRange(value)).toBe(expected);
  });
});
