import { describe, expect, it } from "vitest";
import { formatDays, formatRelativeTime, formatResetType } from "./format";

const NOW = new Date("2026-11-02T12:00:00.000Z");

describe("formatRelativeTime", () => {
  it.each([
    ["2026-11-02T12:00:00.000Z", "just now"],
    ["2026-11-02T11:59:00.001Z", "just now"],
    ["2026-11-02T11:59:00.000Z", "1 min ago"],
    ["2026-11-02T11:54:30.000Z", "5 min ago"],
    ["2026-11-02T11:00:00.001Z", "59 min ago"],
    ["2026-11-02T11:00:00.000Z", "1 h ago"],
    ["2026-11-02T08:01:00.000Z", "3 h ago"],
    ["2026-11-01T12:00:00.001Z", "23 h ago"],
    ["2026-11-01T12:00:00.000Z", "1 day ago"],
    ["2026-10-31T12:00:00.001Z", "1 day ago"],
    ["2026-10-31T12:00:00.000Z", "2 days ago"],
    ["2026-10-03T12:00:00.000Z", "30 days ago"],
  ])("formats %s as %s, rounding down to the unit", (iso, expected) => {
    expect(formatRelativeTime(iso, NOW)).toBe(expected);
  });

  it("honors the UTC offset of the timestamp", () => {
    expect(formatRelativeTime("2026-11-02T06:00:00-03:00", NOW)).toBe(
      "3 h ago",
    );
  });

  it.each([["2026-11-02T12:00:30.000Z"], ["2026-11-04T12:00:00.000Z"]])(
    "renders the future timestamp %s as just now",
    (iso) => {
      expect(formatRelativeTime(iso, NOW)).toBe("just now");
    },
  );

  it.each([[""], ["not a date"]])(
    "renders the unparsable timestamp %j as n/a",
    (iso) => {
      expect(formatRelativeTime(iso, NOW)).toBe("n/a");
    },
  );

  it("renders n/a when the reference time is invalid", () => {
    expect(
      formatRelativeTime("2026-11-02T11:00:00.000Z", new Date(Number.NaN)),
    ).toBe("n/a");
  });
});

describe("formatResetType", () => {
  it.each([
    ["regular", "Regular"],
    ["banked", "Banked"],
  ] as const)("labels %s as %s", (type, expected) => {
    expect(formatResetType(type)).toBe(expected);
  });
});

describe("formatDays", () => {
  it.each([
    [5.9, "5.9 days"],
    [5.857, "5.9 days"],
    [0.9, "0.9 days"],
    [3, "3.0 days"],
    [1, "1.0 days"],
    [0.04, "0.0 days"],
    [0, "0.0 days"],
  ])("formats %s as %s with one decimal", (value, expected) => {
    expect(formatDays(value)).toBe(expected);
  });

  it.each([[null], [Number.NaN], [Number.POSITIVE_INFINITY], [-0.5]])(
    "renders the missing or invalid value %s as n/a",
    (value) => {
      expect(formatDays(value)).toBe("n/a");
    },
  );
});
